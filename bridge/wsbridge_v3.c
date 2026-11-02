// wsbridge — Waypoint Studio <-> DJI RC 2 (DJI Fly) mission bridge over USB/MTP (libmtp).
//
// DJI does not offer an API to import missions into DJI Fly on the DJI RC 2. The only working
// method is to overwrite the KMZ of an existing DJI Fly mission in
//   Android/data/dji.go.v5/files/waypoint/<UUID>/<UUID>.kmz
// This tool does that safely: original is backed up first, the new file is read back and
// compared byte-for-byte, and any failure restores the original automatically.
//
// Commands (all output is one JSON object on stdout; diagnostics go to stderr):
//   wsbridge detect
//   wsbridge list
//   wsbridge scan <tmpDir>        (list + download all mission KMZ and capability/*.json in ONE session;
//                                  MTP object ids are only valid inside the session that enumerated them)
//   wsbridge replace <folderName> <kmzName> <localKmz> <backupDir>
//
// Exit code 0 = ok, 1 = error (JSON has "ok":false, "code", "error").
#include <libmtp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
#include <strings.h>

#define WAYPOINT_PATH_N 5
static const char *WAYPOINT_PATH[WAYPOINT_PATH_N] = { "Android", "data", "dji.go.v5", "files", "waypoint" };

// ---------------- JSON output helpers ----------------
static void jstr(FILE *f, const char *s) {
  fputc('"', f);
  for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
    if (*p == '"' || *p == '\\') { fputc('\\', f); fputc(*p, f); }
    else if (*p == '\n') fputs("\\n", f);
    else if (*p == '\r') fputs("\\r", f);
    else if (*p == '\t') fputs("\\t", f);
    else if (*p < 0x20) fprintf(f, "\\u%04x", *p);
    else fputc(*p, f);
  }
  fputc('"', f);
}
static int fail(const char *code, const char *msg) {
  printf("{\"ok\":false,\"code\":"); jstr(stdout, code); printf(",\"error\":"); jstr(stdout, msg); printf("}\n");
  fflush(stdout);
  return 1;
}
static void dump_mtp_errors(LIBMTP_mtpdevice_t *dev) {
  if (!dev) return;
  for (LIBMTP_error_t *e = LIBMTP_Get_Errorstack(dev); e; e = e->next) fprintf(stderr, "libmtp: %s\n", e->error_text ? e->error_text : "?");
  LIBMTP_Clear_Errorstack(dev);
}

// ---------------- device ----------------
typedef struct { LIBMTP_mtpdevice_t *dev; LIBMTP_raw_device_t raw; } Dev;

static int open_device(Dev *d, char *err, size_t errlen) {
  LIBMTP_raw_device_t *raws = NULL; int n = 0;
  LIBMTP_error_number_t r = LIBMTP_Detect_Raw_Devices(&raws, &n);
  if (r == LIBMTP_ERROR_NO_DEVICE_ATTACHED || n == 0) { snprintf(err, errlen, "NO_DEVICE"); free(raws); return -1; }
  if (r != LIBMTP_ERROR_NONE) { snprintf(err, errlen, "DETECT_FAILED:%d", (int)r); free(raws); return -1; }
  // prefer a DJI device (USB vendor 0x2CA3) if several MTP devices are attached
  int pick = 0;
  for (int i = 0; i < n; i++) if (raws[i].device_entry.vendor_id == 0x2ca3) { pick = i; break; }
  d->raw = raws[pick];
  d->dev = LIBMTP_Open_Raw_Device_Uncached(&raws[pick]);
  free(raws);
  if (!d->dev) { snprintf(err, errlen, "OPEN_FAILED"); return -1; }
  if (LIBMTP_Get_Storage(d->dev, LIBMTP_STORAGE_SORTBY_NOTSORTED) != 0 || !d->dev->storage) { dump_mtp_errors(d->dev); snprintf(err, errlen, "NO_STORAGE"); return -1; }
  return 0;
}
static void close_device(Dev *d) { if (d->dev) LIBMTP_Release_Device(d->dev); d->dev = NULL; }

static void print_device(Dev *d) {
  char *model = LIBMTP_Get_Modelname(d->dev), *manu = LIBMTP_Get_Manufacturername(d->dev), *serial = LIBMTP_Get_Serialnumber(d->dev), *fname = LIBMTP_Get_Friendlyname(d->dev);
  printf("\"device\":{\"manufacturer\":"); jstr(stdout, manu); printf(",\"model\":"); jstr(stdout, model);
  printf(",\"serial\":"); jstr(stdout, serial); printf(",\"name\":"); jstr(stdout, fname);
  printf(",\"vendorId\":%u,\"productId\":%u,\"storages\":[", d->raw.device_entry.vendor_id, d->raw.device_entry.product_id);
  int first = 1;
  for (LIBMTP_devicestorage_t *s = d->dev->storage; s; s = s->next) {
    printf("%s{\"id\":%u,\"description\":", first ? "" : ",", s->id); jstr(stdout, s->StorageDescription);
    printf(",\"free\":%llu,\"capacity\":%llu}", (unsigned long long)s->FreeSpaceInBytes, (unsigned long long)s->MaxCapacity);
    first = 0;
  }
  printf("]}");
  free(model); free(manu); free(serial); free(fname);
}

// find a child object by exact name; returns object id or 0
static uint32_t find_child(LIBMTP_mtpdevice_t *dev, uint32_t storage, uint32_t parent, const char *name, int *isFolder) {
  LIBMTP_file_t *files = LIBMTP_Get_Files_And_Folders(dev, storage, parent), *f, *next;
  uint32_t id = 0;
  for (f = files; f; f = next) {
    next = f->next;
    if (!id && f->filename && strcmp(f->filename, name) == 0) { id = f->item_id; if (isFolder) *isFolder = f->filetype == LIBMTP_FILETYPE_FOLDER; }
    LIBMTP_destroy_file_t(f);
  }
  return id;
}
// locate .../dji.go.v5/files/waypoint on any storage
static int find_waypoint_dir(Dev *d, uint32_t *storage, uint32_t *folder, int *depthReached) {
  *depthReached = 0;
  for (LIBMTP_devicestorage_t *s = d->dev->storage; s; s = s->next) {
    uint32_t parent = LIBMTP_FILES_AND_FOLDERS_ROOT; int k;
    for (k = 0; k < WAYPOINT_PATH_N; k++) {
      int isF = 0; uint32_t id = find_child(d->dev, s->id, parent, WAYPOINT_PATH[k], &isF);
      if (!id || !isF) break;
      parent = id;
    }
    if (k > *depthReached) *depthReached = k;
    if (k == WAYPOINT_PATH_N) { *storage = s->id; *folder = parent; return 0; }
  }
  return -1;
}
static int is_kmz(const char *n) { size_t l = n ? strlen(n) : 0; return l > 4 && strcasecmp(n + l - 4, ".kmz") == 0; }

// ---------------- local file helpers ----------------
static long fsize(const char *p) { struct stat st; return stat(p, &st) == 0 ? (long)st.st_size : -1; }
static unsigned char *readall(const char *p, long *len) {
  FILE *f = fopen(p, "rb"); if (!f) return NULL;
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  unsigned char *b = malloc(n > 0 ? n : 1); if (!b) { fclose(f); return NULL; }
  if (n > 0 && fread(b, 1, n, f) != (size_t)n) { free(b); fclose(f); return NULL; }
  fclose(f); *len = n; return b;
}
static int same_file(const char *a, const char *b) {
  long la, lb; unsigned char *A = readall(a, &la), *B = readall(b, &lb); int same = A && B && la == lb && memcmp(A, B, la) == 0;
  free(A); free(B); return same;
}
static int memhas(const unsigned char *b, long n, const char *s) { size_t l = strlen(s); for (long i = 0; i + (long)l <= n; i++) if (memcmp(b + i, s, l) == 0) return 1; return 0; }
// a DJI Fly mission KMZ must be a ZIP containing wpmz/template.kml and wpmz/waylines.wpml
static int validate_kmz(const char *p, char *why, size_t wl) {
  long n; unsigned char *b = readall(p, &n);
  if (!b) { snprintf(why, wl, "файл не читается"); return -1; }
  int ok = 1;
  if (n < 200 || n > 20 * 1024 * 1024) { snprintf(why, wl, "неверный размер файла (%ld байт)", n); ok = 0; }
  else if (!(b[0] == 'P' && b[1] == 'K' && b[2] == 3 && b[3] == 4)) { snprintf(why, wl, "это не KMZ (ZIP)"); ok = 0; }
  else if (!memhas(b, n, "wpmz/template.kml")) { snprintf(why, wl, "в KMZ нет wpmz/template.kml"); ok = 0; }
  else if (!memhas(b, n, "wpmz/waylines.wpml")) { snprintf(why, wl, "в KMZ нет wpmz/waylines.wpml"); ok = 0; }
  free(b);
  return ok ? 0 : -1;
}

// ---------------- MTP file ops ----------------
static int mtp_pull(LIBMTP_mtpdevice_t *dev, uint32_t id, const char *dest) {
  unlink(dest);
  int r = LIBMTP_Get_File_To_File(dev, id, dest, NULL, NULL);
  if (r != 0) dump_mtp_errors(dev);
  return r;
}
static int mtp_push(LIBMTP_mtpdevice_t *dev, const char *local, uint32_t storage, uint32_t parent, const char *name, uint32_t *newId) {
  LIBMTP_file_t *fd = LIBMTP_new_file_t();
  fd->filename = strdup(name);
  fd->filesize = (uint64_t)fsize(local);
  fd->filetype = LIBMTP_FILETYPE_UNKNOWN;
  fd->parent_id = parent;
  fd->storage_id = storage;
  int r = LIBMTP_Send_File_From_File(dev, local, fd, NULL, NULL);
  if (r != 0) dump_mtp_errors(dev);
  if (newId) *newId = fd->item_id;
  LIBMTP_destroy_file_t(fd);
  return r;
}

// ---------------- commands ----------------
static int cmd_detect(void) {
  Dev d = {0}; char err[64];
  if (open_device(&d, err, sizeof err)) return fail(err, "Пульт не найден или занят");
  printf("{\"ok\":true,"); print_device(&d);
  uint32_t st, wf; int depth;
  printf(",\"waypointFolder\":%s,\"depth\":", find_waypoint_dir(&d, &st, &wf, &depth) == 0 ? "true" : "false");
  printf("%d}\n", depth);
  close_device(&d); return 0;
}

static int cmd_list(void) {
  Dev d = {0}; char err[64];
  if (open_device(&d, err, sizeof err)) return fail(err, "Пульт не найден или занят");
  uint32_t storage, wdir; int depth;
  if (find_waypoint_dir(&d, &storage, &wdir, &depth)) {
    close_device(&d);
    char m[200]; snprintf(m, sizeof m, "Папка Android/data/dji.go.v5/files/waypoint не найдена (дошли до уровня %d из 5)", depth);
    return fail("NO_WAYPOINT_FOLDER", m);
  }
  printf("{\"ok\":true,"); print_device(&d); printf(",\"storage\":%u,\"waypointDir\":%u,\"missions\":[", storage, wdir);
  LIBMTP_file_t *folders = LIBMTP_Get_Files_And_Folders(d.dev, storage, wdir), *f, *next;
  int first = 1;
  for (f = folders; f; f = next) {
    next = f->next;
    if (f->filetype == LIBMTP_FILETYPE_FOLDER) {
      printf("%s{\"folder\":", first ? "" : ","); jstr(stdout, f->filename);
      printf(",\"folderId\":%u,\"folderTime\":%lld,\"files\":[", f->item_id, (long long)f->modificationdate);
      LIBMTP_file_t *items = LIBMTP_Get_Files_And_Folders(d.dev, storage, f->item_id), *g, *gn; int fi = 1;
      for (g = items; g; g = gn) {
        gn = g->next;
        printf("%s{\"name\":", fi ? "" : ","); jstr(stdout, g->filename);
        printf(",\"id\":%u,\"size\":%llu,\"time\":%lld,\"folder\":%s,\"kmz\":%s}", g->item_id, (unsigned long long)g->filesize, (long long)g->modificationdate,
               g->filetype == LIBMTP_FILETYPE_FOLDER ? "true" : "false", is_kmz(g->filename) ? "true" : "false");
        fi = 0; LIBMTP_destroy_file_t(g);
      }
      printf("]}");
      first = 0;
    } else {
      // loose files directly in waypoint/ (reported for diagnostics)
      printf("%s{\"folder\":null,\"file\":", first ? "" : ","); jstr(stdout, f->filename);
      printf(",\"id\":%u,\"size\":%llu,\"time\":%lld}", f->item_id, (unsigned long long)f->filesize, (long long)f->modificationdate);
      first = 0;
    }
    LIBMTP_destroy_file_t(f);
  }
  printf("]}\n");
  close_device(&d); return 0;
}

// list + download every mission KMZ in one MTP session (fast; used to show mission details before overwriting)
static int cmd_scan(const char *dir) {
  Dev d = {0}; char err[64];
  if (open_device(&d, err, sizeof err)) return fail(err, "Пульт не найден или занят");
  uint32_t storage, wdir; int depth;
  if (find_waypoint_dir(&d, &storage, &wdir, &depth)) {
    close_device(&d);
    char m[200]; snprintf(m, sizeof m, "Папка Android/data/dji.go.v5/files/waypoint не найдена (дошли до уровня %d из 5)", depth);
    return fail("NO_WAYPOINT_FOLDER", m);
  }
  mkdir(dir, 0755);
  printf("{\"ok\":true,"); print_device(&d); printf(",\"missions\":[");
  LIBMTP_file_t *folders = LIBMTP_Get_Files_And_Folders(d.dev, storage, wdir), *f, *next; int first = 1;
  for (f = folders; f; f = next) {
    next = f->next;
    if (f->filetype == LIBMTP_FILETYPE_FOLDER) {
      LIBMTP_file_t *items = LIBMTP_Get_Files_And_Folders(d.dev, storage, f->item_id), *g, *gn;
      int nk = 0; uint32_t kid = 0; char kname[512] = ""; uint64_t ksize = 0; long long ktime = 0;
      char want[600]; snprintf(want, sizeof want, "%s.kmz", f->filename ? f->filename : "");
      for (g = items; g; g = gn) {
        gn = g->next;
        if (g->filetype != LIBMTP_FILETYPE_FOLDER && is_kmz(g->filename)) {
          nk++;
          if (!kid || strcmp(g->filename, want) == 0) { kid = g->item_id; snprintf(kname, sizeof kname, "%s", g->filename); ksize = g->filesize; ktime = (long long)g->modificationdate; }
        }
        LIBMTP_destroy_file_t(g);
      }
      printf("%s{\"folder\":", first ? "" : ","); jstr(stdout, f->filename);
      printf(",\"folderTime\":%lld,\"kmzCount\":%d", (long long)f->modificationdate, nk);
      if (kid) {
        char dest[4096]; snprintf(dest, sizeof dest, "%s/%u.kmz", dir, kid);
        int ok = mtp_pull(d.dev, kid, dest) == 0;
        printf(",\"kmz\":"); jstr(stdout, kname); printf(",\"id\":%u,\"size\":%llu,\"time\":%lld,\"local\":", kid, (unsigned long long)ksize, ktime);
        if (ok) jstr(stdout, dest); else printf("null");
      }
      printf("}"); first = 0;
    }
    LIBMTP_destroy_file_t(f);
  }
  printf("],\"capability\":{");
  int ci; uint32_t cap = find_child(d.dev, storage, wdir, "capability", &ci); int cf = 1;
  if (cap && ci) {
    LIBMTP_file_t *cs = LIBMTP_Get_Files_And_Folders(d.dev, storage, cap), *c, *cn;
    for (c = cs; c; c = cn) {
      cn = c->next;
      if (c->filetype != LIBMTP_FILETYPE_FOLDER && c->filesize < 65536) {
        char dest[4096]; snprintf(dest, sizeof dest, "%s/cap_%u.json", dir, c->item_id);
        long n = 0; unsigned char *buf = NULL;
        if (mtp_pull(d.dev, c->item_id, dest) == 0 && (buf = readall(dest, &n))) {
          char *z = malloc(n + 1); memcpy(z, buf, n); z[n] = 0;
          printf("%s", cf ? "" : ","); jstr(stdout, c->filename); printf(":"); jstr(stdout, z); cf = 0;
          free(z); free(buf);
        }
      }
      LIBMTP_destroy_file_t(c);
    }
  }
  printf("}}\n");
  close_device(&d); return 0;
}

__attribute__((unused)) static int cmd_pull(uint32_t id, const char *dest) {
  Dev d = {0}; char err[64];
  if (open_device(&d, err, sizeof err)) return fail(err, "Пульт не найден или занят");
  int r = mtp_pull(d.dev, id, dest);
  close_device(&d);
  if (r) return fail("PULL_FAILED", "Не удалось скачать файл с пульта");
  printf("{\"ok\":true,\"file\":"); jstr(stdout, dest); printf(",\"size\":%ld}\n", fsize(dest));
  return 0;
}

// Safe overwrite of <waypoint>/<folderName>/<kmzName> with localKmz.
static int cmd_replace(const char *folderName, const char *kmzName, const char *local, const char *backupDir) {
  char why[200];
  if (strchr(folderName, '/') || strchr(kmzName, '/') || !is_kmz(kmzName)) return fail("BAD_ARGS", "Неверное имя папки или файла задания");
  if (validate_kmz(local, why, sizeof why)) return fail("BAD_KMZ", why);

  Dev d = {0}; char err[64];
  if (open_device(&d, err, sizeof err)) return fail(err, "Пульт не найден или занят");
  uint32_t storage, wdir; int depth;
  if (find_waypoint_dir(&d, &storage, &wdir, &depth)) { close_device(&d); return fail("NO_WAYPOINT_FOLDER", "Папка заданий DJI Fly не найдена на пульте"); }
  int isF = 0;
  uint32_t folder = find_child(d.dev, storage, wdir, folderName, &isF);
  if (!folder || !isF) { close_device(&d); return fail("NO_MISSION", "Выбранное задание не найдено на пульте (обновите список)"); }
  uint32_t target = find_child(d.dev, storage, folder, kmzName, &isF);
  if (!target || isF) { close_device(&d); return fail("NO_MISSION_FILE", "Файл задания не найден в папке задания (обновите список)"); }

  // 1. backup the original
  mkdir(backupDir, 0755);
  char ts[32]; time_t now = time(NULL); strftime(ts, sizeof ts, "%Y%m%d-%H%M%S", localtime(&now));
  char backup[4096]; snprintf(backup, sizeof backup, "%s/%s__%s", backupDir, ts, kmzName);
  if (mtp_pull(d.dev, target, backup) || fsize(backup) <= 0) { close_device(&d); return fail("BACKUP_FAILED", "Не удалось сохранить резервную копию — пульт не изменён"); }

  // 2. upload the new mission under a temporary name (DJI Fly ignores non-.kmz files) and verify it
  char tmpName[600]; snprintf(tmpName, sizeof tmpName, "%s.wsnew", kmzName);
  char verify[4096]; snprintf(verify, sizeof verify, "%s/.verify_%s", backupDir, kmzName);
  uint32_t old = find_child(d.dev, storage, folder, tmpName, NULL); if (old) LIBMTP_Delete_Object(d.dev, old);
  uint32_t tmpId = 0;
  if (mtp_push(d.dev, local, storage, folder, tmpName, &tmpId) != 0) {
    uint32_t part = find_child(d.dev, storage, folder, tmpName, NULL); if (part) LIBMTP_Delete_Object(d.dev, part);
    close_device(&d); return fail("UPLOAD_FAILED", "Не удалось записать файл на пульт — исходное задание не тронуто");
  }
  if (!tmpId) tmpId = find_child(d.dev, storage, folder, tmpName, NULL);
  int okTmp = tmpId && mtp_pull(d.dev, tmpId, verify) == 0 && same_file(local, verify);
  unlink(verify);
  if (!okTmp) { if (tmpId) LIBMTP_Delete_Object(d.dev, tmpId); close_device(&d); return fail("VERIFY_FAILED", "Проверка записанного файла не прошла — исходное задание не тронуто. Повторите."); }

  // 3. remove the original and give the verified file the original name
  if (LIBMTP_Delete_Object(d.dev, target) != 0) { dump_mtp_errors(d.dev); LIBMTP_Delete_Object(d.dev, tmpId); close_device(&d); return fail("DELETE_FAILED", "Пульт не разрешил заменить файл — исходное задание не тронуто"); }
  int renamed = 0;
  LIBMTP_file_t *meta = LIBMTP_Get_Filemetadata(d.dev, tmpId);
  if (meta) { renamed = LIBMTP_Set_File_Name(d.dev, meta, kmzName) == 0; LIBMTP_destroy_file_t(meta); }
  if (!renamed) dump_mtp_errors(d.dev);
  uint32_t finalId = renamed ? find_child(d.dev, storage, folder, kmzName, NULL) : 0;
  const char *method = "rename";
  if (!finalId) { // device can't rename: write the file again under the final name
    method = "rewrite";
    if (mtp_push(d.dev, local, storage, folder, kmzName, &finalId) != 0) finalId = 0;
    if (!finalId) finalId = find_child(d.dev, storage, folder, kmzName, NULL);
  }
  // 4. final verification of the file DJI Fly will read
  int ok = finalId && mtp_pull(d.dev, finalId, verify) == 0 && same_file(local, verify);
  unlink(verify);
  uint32_t leftover = find_child(d.dev, storage, folder, tmpName, NULL); if (leftover) LIBMTP_Delete_Object(d.dev, leftover);
  if (ok) {
    close_device(&d);
    printf("{\"ok\":true,\"backup\":"); jstr(stdout, backup); printf(",\"size\":%ld,\"verified\":true,\"method\":", fsize(local)); jstr(stdout, method); printf("}\n");
    return 0;
  }
  // 5. rollback: put the original back and verify it
  fprintf(stderr, "final verification failed, restoring original\n");
  uint32_t bad = find_child(d.dev, storage, folder, kmzName, NULL);
  if (bad) LIBMTP_Delete_Object(d.dev, bad);
  uint32_t rid = 0; int restored = mtp_push(d.dev, backup, storage, folder, kmzName, &rid) == 0;
  if (restored) { if (!rid) rid = find_child(d.dev, storage, folder, kmzName, NULL); restored = rid && mtp_pull(d.dev, rid, verify) == 0 && same_file(backup, verify); unlink(verify); }
  close_device(&d);
  if (restored) return fail("VERIFY_FAILED", "Запись не подтвердилась, исходное задание на пульте восстановлено. Повторите попытку.");
  char m[4400]; snprintf(m, sizeof m, "Запись не подтвердилась и восстановление тоже. Резервная копия задания: %s", backup);
  return fail("RESTORE_FAILED", m);
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: wsbridge detect|list|pull <id> <dest>|replace <folder> <kmzName> <local.kmz> <backupDir>\n"); return 2; }
  LIBMTP_Set_Debug(getenv("WSBRIDGE_DEBUG") ? LIBMTP_DEBUG_ALL : LIBMTP_DEBUG_NONE);
  LIBMTP_Init();
  if (!strcmp(argv[1], "detect")) return cmd_detect();
  if (!strcmp(argv[1], "list")) return cmd_list();
  if (!strcmp(argv[1], "scan") && argc == 3) return cmd_scan(argv[2]);
  if (!strcmp(argv[1], "replace") && argc == 6) return cmd_replace(argv[2], argv[3], argv[4], argv[5]);
  return fail("BAD_ARGS", "Неизвестная команда");
}
