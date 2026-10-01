/* SPDX-License-Identifier: Apache-2.0 */
#define _GNU_SOURCE
#include "state.h"
#include "ext-image-copy-capture-v1-client-protocol.h"
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

struct pk_shm_capture {
    struct pk_cursor *cursor;
    struct wl_shm *shm;
    struct ext_image_copy_capture_frame_v1 *frame;
    struct wl_buffer *buffer;
    void *pixels;
    size_t length;
    uint32_t width, height, format;
    uint32_t buffer_width, buffer_height, buffer_format;
    bool has_format, done, has_time, has_transform;
    int64_t presentation_ns;
    uint32_t transform;
};

static void next_frame(struct pk_shm_capture *capture);

static void release_buffer(struct pk_shm_capture *s)
{
    if (s->buffer) wl_buffer_destroy(s->buffer);
    s->buffer = NULL;
    if (s->pixels) munmap(s->pixels, s->length);
    s->pixels = NULL;
    s->length = 0;
}

static int allocate_buffer(struct pk_shm_capture *s)
{
    if (!s->width || !s->height || s->width > PK_CURSOR_MAX_SIDE ||
        s->height > PK_CURSOR_MAX_SIDE || !s->has_format) return -ENOTSUP;
    if (s->buffer && s->width == s->buffer_width && s->height == s->buffer_height &&
        s->format == s->buffer_format) return 0;
    release_buffer(s);
    const size_t length = (size_t)s->width * s->height * 4;
    int fd = memfd_create("platform-kits-cursor", MFD_CLOEXEC);
    if (fd < 0) return -errno;
    if (ftruncate(fd, (off_t)length) < 0) { int error = errno; close(fd); return -error; }
    void *pixels = mmap(NULL, length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (pixels == MAP_FAILED) { int error = errno; close(fd); return -error; }
    struct wl_shm_pool *pool = wl_shm_create_pool(s->shm, fd, (int32_t)length);
    close(fd);
    if (!pool) { munmap(pixels, length); return -ENOMEM; }
    s->buffer = wl_shm_pool_create_buffer(pool, 0, (int32_t)s->width,
        (int32_t)s->height, (int32_t)s->width * 4, s->format);
    wl_shm_pool_destroy(pool);
    if (!s->buffer) { munmap(pixels, length); return -ENOMEM; }
    s->pixels = pixels;
    s->length = length;
    s->buffer_width = s->width;
    s->buffer_height = s->height;
    s->buffer_format = s->format;
    return 0;
}

static void frame_transform(void *data, struct ext_image_copy_capture_frame_v1 *frame, uint32_t transform)
{
    (void)frame;
    struct pk_shm_capture *s = data;
    s->transform = transform;
    s->has_transform = true;
}

static void frame_damage(void *data, struct ext_image_copy_capture_frame_v1 *frame,
                         int32_t x, int32_t y, int32_t width, int32_t height)
{ (void)data; (void)frame; (void)x; (void)y; (void)width; (void)height; }

static void frame_time(void *data, struct ext_image_copy_capture_frame_v1 *frame,
                       uint32_t hi, uint32_t lo, uint32_t ns)
{
    (void)frame;
    struct pk_shm_capture *s = data;
    const uint64_t seconds = ((uint64_t)hi << 32) | lo;
    if (ns >= 1000000000 || seconds > ((uint64_t)INT64_MAX - ns) / 1000000000) {
        pk_cursor_stop(s->cursor);
        return;
    }
    s->presentation_ns = (int64_t)(seconds * 1000000000 + ns);
    s->has_time = true;
}

static void frame_ready(void *data, struct ext_image_copy_capture_frame_v1 *frame)
{
    struct pk_shm_capture *s = data;
    ext_image_copy_capture_frame_v1_destroy(frame);
    s->frame = NULL;
    if (!s->has_time || !s->has_transform) { pk_cursor_stop(s->cursor); return; }
    const int result = pk_cursor_image_ready(s->cursor, s->pixels, s->length,
        s->buffer_width, s->buffer_height, s->buffer_width * 4,
        s->buffer_format, s->transform, s->presentation_ns);
    if (result < 0) { pk_cursor_stop(s->cursor); return; }
    next_frame(s);
}

static void frame_failed(void *data, struct ext_image_copy_capture_frame_v1 *frame, uint32_t reason)
{
    struct pk_shm_capture *s = data;
    ext_image_copy_capture_frame_v1_destroy(frame);
    s->frame = NULL;
    (void)reason;
    /* No tight retry loop and no stale image after failed/denied capture. */
    pk_cursor_stop(s->cursor);
}

static const struct ext_image_copy_capture_frame_v1_listener frame_events = {
    .transform = frame_transform, .damage = frame_damage, .presentation_time = frame_time,
    .ready = frame_ready, .failed = frame_failed,
};

static void next_frame(struct pk_shm_capture *s)
{
    if (s->cursor->stopped || s->frame || !s->done) return;
    if (allocate_buffer(s) < 0) { pk_cursor_stop(s->cursor); return; }
    s->has_time = false;
    s->has_transform = false;
    s->frame = ext_image_copy_capture_session_v1_create_frame(s->cursor->image_session);
    if (!s->frame) { pk_cursor_stop(s->cursor); return; }
    if (ext_image_copy_capture_frame_v1_add_listener(s->frame, &frame_events, s) < 0) {
        ext_image_copy_capture_frame_v1_destroy(s->frame);
        s->frame = NULL;
        pk_cursor_stop(s->cursor);
        return;
    }
    ext_image_copy_capture_frame_v1_attach_buffer(s->frame, s->buffer);
    ext_image_copy_capture_frame_v1_damage_buffer(s->frame, 0, 0,
        (int32_t)s->buffer_width, (int32_t)s->buffer_height);
    ext_image_copy_capture_frame_v1_capture(s->frame);
}

static void buffer_size(void *data, struct ext_image_copy_capture_session_v1 *session,
                        uint32_t width, uint32_t height)
{
    (void)session;
    struct pk_shm_capture *s = data;
    s->width = width;
    s->height = height;
    s->has_format = false;
    s->done = false;
}
static void shm_format(void *data, struct ext_image_copy_capture_session_v1 *session, uint32_t format)
{
    (void)session;
    struct pk_shm_capture *s = data;
    if (format == WL_SHM_FORMAT_ARGB8888 || (!s->has_format && format == WL_SHM_FORMAT_XRGB8888)) {
        s->format = format;
        s->has_format = true;
    }
}
static void dmabuf_device(void *data, struct ext_image_copy_capture_session_v1 *session, struct wl_array *device)
{ (void)data; (void)session; (void)device; }
static void dmabuf_format(void *data, struct ext_image_copy_capture_session_v1 *session,
                          uint32_t format, struct wl_array *modifiers)
{ (void)data; (void)session; (void)format; (void)modifiers; }
static void done(void *data, struct ext_image_copy_capture_session_v1 *session)
{
    (void)session;
    struct pk_shm_capture *s = data;
    s->done = true;
    next_frame(s);
}
static void stopped(void *data, struct ext_image_copy_capture_session_v1 *session)
{ (void)session; struct pk_shm_capture *s = data; pk_cursor_stop(s->cursor); }

static const struct ext_image_copy_capture_session_v1_listener session_events = {
    .buffer_size = buffer_size, .shm_format = shm_format, .dmabuf_device = dmabuf_device,
    .dmabuf_format = dmabuf_format, .done = done, .stopped = stopped,
};

int pk_cursor_capture_shm(struct pk_cursor *c, struct wl_shm *shm)
{
    if (!c || !shm || !c->image_session || c->stopped) return -EINVAL;
    if (c->capture) return -EALREADY;
    struct pk_shm_capture *s = calloc(1, sizeof(*s));
    if (!s) return -ENOMEM;
    s->cursor = c;
    s->shm = shm;
    if (ext_image_copy_capture_session_v1_add_listener(c->image_session, &session_events, s) < 0) {
        free(s);
        return -EALREADY;
    }
    c->capture = s;
    return 0;
}

void pk_cursor_capture_destroy(struct pk_cursor *c)
{
    if (!c->capture) return;
    struct pk_shm_capture *s = c->capture;
    if (s->frame) ext_image_copy_capture_frame_v1_destroy(s->frame);
    release_buffer(s);
    free(s);
    c->capture = NULL;
}
