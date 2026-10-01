/* SPDX-License-Identifier: Apache-2.0 */
#include "state.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <spa/buffer/meta.h>
#include <spa/param/video/format.h>
#include <wayland-client-protocol.h>

static void changed(struct pk_cursor *c)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0 || c->revision == UINT64_MAX) {
        c->stopped = true;
        if (c->wake) c->wake(c->wake_data);
        return;
    }
    c->observed_ns = (int64_t)now.tv_sec * 1000000000 + now.tv_nsec;
    c->revision++;
    if (c->wake && c->positioned && c->image_known) c->wake(c->wake_data);
}

void pk_cursor_set_wake(struct pk_cursor *c, void (*callback)(void *), void *data)
{
    c->wake = callback;
    c->wake_data = data;
}

void pk_cursor_enter(struct pk_cursor *c)
{
    if (!c->entered) {
        c->entered = true;
        /* Wait for the new position after enter; never replay the old one. */
        c->positioned = false;
        changed(c);
    }
}

void pk_cursor_leave(struct pk_cursor *c)
{
    if (c->entered) {
        c->entered = false;
        changed(c);
    }
}

void pk_cursor_position(struct pk_cursor *c, int32_t x, int32_t y)
{
    if (c->stopped || !c->entered) return;
    if (!c->positioned || c->x != x || c->y != y) {
        c->positioned = true;
        c->x = x;
        c->y = y;
        changed(c);
    }
}

void pk_cursor_hotspot(struct pk_cursor *c, int32_t x, int32_t y)
{
    c->hotspot_known = true;
    c->pending_hotspot_x = x;
    c->pending_hotspot_y = y;
}

void pk_cursor_stop(struct pk_cursor *c)
{
    if (c->stopped) return;
    c->stopped = true;
    if (c->wake) c->wake(c->wake_data);
}

int pk_cursor_image_ready(struct pk_cursor *c, const void *pixels, size_t length,
                         uint32_t w, uint32_t h, uint32_t stride,
                         uint32_t format, uint32_t transform,
                         int64_t presentation_ns)
{
    const uint16_t endian = 1;
    if (c->stopped) return -EPIPE;
    if (!c->hotspot_known) return -EAGAIN;
    if (transform != WL_OUTPUT_TRANSFORM_NORMAL || *(const uint8_t *)&endian != 1 ||
        (format != WL_SHM_FORMAT_ARGB8888 && format != WL_SHM_FORMAT_XRGB8888)) {
        pk_cursor_stop(c);
        return -ENOTSUP;
    }
    if (!pixels || !w || !h || w > PK_CURSOR_MAX_SIDE || h > PK_CURSOR_MAX_SIDE ||
        stride < w * 4 || (size_t)(h - 1) * stride + w * 4 > length || presentation_ns < 0 ||
        (c->image_known && presentation_ns < c->presentation_ns)) {
        pk_cursor_stop(c);
        return -EINVAL;
    }
    const size_t bytes = (size_t)w * h * 4;
    unsigned char *image = malloc(bytes);
    if (!image) { pk_cursor_stop(c); return -ENOMEM; }
    bool visible = false;
    for (uint32_t y = 0; y < h; y++) {
        memcpy(image + (size_t)y * w * 4, (const unsigned char *)pixels + (size_t)y * stride, w * 4);
        for (uint32_t x = 0; x < w; x++) {
            unsigned char *alpha = image + ((size_t)y * w + x) * 4 + 3;
            if (format == WL_SHM_FORMAT_XRGB8888) *alpha = 255;
            visible |= *alpha != 0;
        }
    }
    const bool differs = !c->image_known || c->image_width != w || c->image_height != h ||
        c->hotspot_x != c->pending_hotspot_x || c->hotspot_y != c->pending_hotspot_y ||
        memcmp(c->image, image, bytes) != 0;
    free(c->image);
    c->image = image;
    c->image_width = w;
    c->image_height = h;
    c->image_known = true;
    c->image_visible = visible;
    c->hotspot_x = c->pending_hotspot_x;
    c->hotspot_y = c->pending_hotspot_y;
    c->presentation_ns = presentation_ns;
    if (differs) changed(c);
    return 0;
}

int pk_cursor_write(struct pk_cursor *c, struct spa_buffer *buffer,
                    struct pk_cursor_provenance *p)
{
    if (p) memset(p, 0, sizeof(*p));
    struct spa_meta *meta = spa_buffer_find_meta(buffer, SPA_META_Cursor);
    if (!meta || !meta->data || meta->size < sizeof(struct spa_meta_cursor)) return -ENOSPC;
    /* Clear recycled state even on errors and before initial real observations. */
    struct spa_meta_cursor out = {0};
    memcpy(meta->data, &out, sizeof(out));
    if (c->stopped) return -EPIPE;
    if (!c->positioned || !c->image_known) return -EAGAIN;
    if (c->revision == c->queued_revision) return 0;
    const bool visible = c->entered && c->image_visible && c->x >= 0 && c->y >= 0 &&
        (uint32_t)c->x < c->source_width && (uint32_t)c->y < c->source_height;
    const size_t bytes = visible ? (size_t)c->image_width * c->image_height * 4 : 0;
    const size_t header_bytes = sizeof(out) + sizeof(struct spa_meta_bitmap);
    if (meta->size < header_bytes + bytes) return -ENOSPC;
    /* Always send a complete bitmap or explicit invisible marker. This avoids
     * stale per-buffer bitmaps and correctly restores visibility on re-enter. */
    out.id = 1;
    out.position = SPA_POINT(c->x, c->y);
    out.hotspot = SPA_POINT(c->hotspot_x, c->hotspot_y);
    out.bitmap_offset = sizeof(out);
    const struct spa_meta_bitmap bitmap = {
        .format = SPA_VIDEO_FORMAT_BGRA,
        .size = SPA_RECTANGLE(c->image_width, c->image_height),
        .stride = (int32_t)c->image_width * 4,
        .offset = visible ? sizeof(bitmap) : 0,
    };
    memcpy(meta->data, &out, sizeof(out));
    memcpy((unsigned char *)meta->data + sizeof(out), &bitmap, sizeof(bitmap));
    if (bytes) memcpy((unsigned char *)meta->data + header_bytes, c->image, bytes);
    if (p) *p = (struct pk_cursor_provenance) {
        .revision = c->revision, .observed_monotonic_ns = c->observed_ns,
        .image_presentation_ns = c->presentation_ns,
        .x = c->x, .y = c->y, .visible = visible,
    };
    return 1;
}

void pk_cursor_queued(struct pk_cursor *c, uint64_t revision)
{
    if (revision > c->queued_revision && revision <= c->revision) c->queued_revision = revision;
}
