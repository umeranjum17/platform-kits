/* SPDX-License-Identifier: Apache-2.0 */
#ifndef PLATFORM_KITS_CURSOR_STATE_H
#define PLATFORM_KITS_CURSOR_STATE_H
#include "cursor.h"

/* Private event state. Tests call these with fixtures; product events come from
 * the public protocol listener only. No fabricated position initialization.
 */
#define PK_CURSOR_MAX_SIDE 512u
#define PK_CURSOR_META_SIZE (sizeof(struct spa_meta_cursor) + \
    sizeof(struct spa_meta_bitmap) + PK_CURSOR_MAX_SIDE * PK_CURSOR_MAX_SIDE * 4u)

struct pk_cursor {
    struct ext_image_copy_capture_cursor_session_v1 *pointer_session;
    struct ext_image_copy_capture_session_v1 *image_session;
    uint32_t source_width, source_height;
    bool entered, positioned, hotspot_known, image_known, image_visible, stopped;
    int32_t x, y, hotspot_x, hotspot_y, pending_hotspot_x, pending_hotspot_y;
    uint32_t image_width, image_height;
    unsigned char *image;
    uint64_t revision, queued_revision;
    int64_t observed_ns, presentation_ns;
};

void pk_cursor_enter(struct pk_cursor *cursor);
void pk_cursor_leave(struct pk_cursor *cursor);
void pk_cursor_position(struct pk_cursor *cursor, int32_t x, int32_t y);
void pk_cursor_hotspot(struct pk_cursor *cursor, int32_t x, int32_t y);
#endif
