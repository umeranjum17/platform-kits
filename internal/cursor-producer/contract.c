/* SPDX-License-Identifier: Apache-2.0 */
/* Offline protocol fixtures ONLY. Never use this executable as live proof. */
#include "state.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <spa/param/video/format.h>
#include <wayland-client-protocol.h>

int main(void)
{
    unsigned char *data = calloc(1, PK_CURSOR_META_SIZE);
    assert(data);
    struct spa_meta_header header = { .pts = 923456789, .seq = 99 };
    struct spa_meta meta[] = {
        { SPA_META_Cursor, PK_CURSOR_META_SIZE, data },
        { SPA_META_Header, sizeof(header), &header },
    };
    struct spa_buffer buffer = { .n_metas = 2, .metas = meta };
    struct pk_cursor c = { .source_width = 1920, .source_height = 1080 };
    struct pk_cursor_provenance sample;
    struct spa_meta_cursor *out = (void *)data;
    const unsigned char image[] = { 1, 2, 3, 255, 4, 5, 6, 0 };
    assert(pk_cursor_write(&c, &buffer, &sample) == -EAGAIN && out->id == 0);
    pk_cursor_enter(&c);
    assert(pk_cursor_image_ready(&c, image, sizeof(image), 2, 1, 8,
        WL_SHM_FORMAT_ARGB8888, WL_OUTPUT_TRANSFORM_NORMAL, 100) == -EAGAIN);
    pk_cursor_hotspot(&c, 1, 0);
    assert(pk_cursor_image_ready(&c, image, sizeof(image), 2, 1, 8,
        WL_SHM_FORMAT_ARGB8888, WL_OUTPUT_TRANSFORM_NORMAL, 100) == 0);
    assert(pk_cursor_write(&c, &buffer, &sample) == -EAGAIN && out->id == 0);
    /* Protocol coordinates already include selected-source normalization and
     * transform. They must pass through without desktop origin/hotspot addition. */
    pk_cursor_position(&c, 103, 207);
    assert(pk_cursor_write(&c, &buffer, &sample) == 1);
    assert(out->id != 0 && out->position.x == 103 && out->position.y == 207);
    assert(out->hotspot.x == 1 && sample.visible && sample.observed_monotonic_ns > 0);
    const int64_t first_observed = sample.observed_monotonic_ns;
    struct spa_meta_bitmap *bitmap = (void *)(data + out->bitmap_offset);
    assert(bitmap->format == SPA_VIDEO_FORMAT_BGRA && bitmap->offset == sizeof(*bitmap));
    assert(memcmp((unsigned char *)bitmap + bitmap->offset, image, sizeof(image)) == 0);
    /* Failed queue must not consume a sample; retry is the same observation. */
    assert(pk_cursor_write(&c, &buffer, &sample) == 1);
    pk_cursor_queued(&c, sample.revision);
    assert(pk_cursor_write(&c, &buffer, &sample) == 0 && out->id == 0);
    pk_cursor_position(&c, 103, 207);
    assert(pk_cursor_write(&c, &buffer, &sample) == 0 && out->id == 0);
    pk_cursor_hotspot(&c, 0, 0);
    pk_cursor_position(&c, -1, 207);
    assert(pk_cursor_write(&c, &buffer, &sample) == 1 && !sample.visible);
    assert(out->hotspot.x == 1); /* pending hotspot must not apply yet */
    bitmap = (void *)(data + out->bitmap_offset);
    assert(out->id != 0 && bitmap->offset == 0 && bitmap->format != 0);
    pk_cursor_queued(&c, sample.revision);
    pk_cursor_position(&c, 1919, 1079);
    assert(pk_cursor_write(&c, &buffer, &sample) == 1 && sample.visible);
    assert(sample.observed_monotonic_ns >= first_observed);
    pk_cursor_queued(&c, sample.revision);
    pk_cursor_leave(&c);
    assert(pk_cursor_write(&c, &buffer, &sample) == 1 && !sample.visible);
    pk_cursor_queued(&c, sample.revision);
    pk_cursor_enter(&c);
    assert(pk_cursor_write(&c, &buffer, &sample) == -EAGAIN && out->id == 0);
    pk_cursor_position(&c, 1919, 1079);
    assert(pk_cursor_write(&c, &buffer, &sample) == 1 && sample.visible);
    pk_cursor_queued(&c, sample.revision);
    const unsigned char transparent[] = { 0, 0, 0, 0, 0, 0, 0, 0 };
    assert(pk_cursor_image_ready(&c, transparent, sizeof(transparent), 2, 1, 8,
        WL_SHM_FORMAT_ARGB8888, WL_OUTPUT_TRANSFORM_NORMAL, 200) == 0);
    assert(pk_cursor_write(&c, &buffer, &sample) == 1 && !sample.visible && out->hotspot.x == 0);
    pk_cursor_queued(&c, sample.revision);
    /* XRGB's unused alpha byte cannot make a genuine image invisible. */
    assert(pk_cursor_image_ready(&c, transparent, sizeof(transparent), 2, 1, 8,
        WL_SHM_FORMAT_XRGB8888, WL_OUTPUT_TRANSFORM_NORMAL, 300) == 0);
    meta[0].size = sizeof(*out);
    assert(pk_cursor_write(&c, &buffer, &sample) == -ENOSPC && out->id == 0);
    meta[0].size = PK_CURSOR_META_SIZE;
    assert(pk_cursor_write(&c, &buffer, &sample) == 1 && sample.visible);
    pk_cursor_stop(&c);
    assert(pk_cursor_write(&c, &buffer, &sample) == -EPIPE && out->id == 0);
    assert(header.pts == 923456789 && header.seq == 99);
    free(c.image);
    free(data);
    puts("offline SPA contract passed; live Hyprland/portal support UNQUALIFIED");
    return 0;
}
