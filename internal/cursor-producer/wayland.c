/* SPDX-License-Identifier: Apache-2.0 */
#include "state.h"
#include "ext-image-copy-capture-v1-client-protocol.h"
#include <stdlib.h>

static void enter(void *data, struct ext_image_copy_capture_cursor_session_v1 *session)
{ (void)session; pk_cursor_enter(data); }
static void leave(void *data, struct ext_image_copy_capture_cursor_session_v1 *session)
{ (void)session; pk_cursor_leave(data); }
static void position(void *data, struct ext_image_copy_capture_cursor_session_v1 *session,
                     int32_t x, int32_t y)
{ (void)session; pk_cursor_position(data, x, y); }
static void hotspot(void *data, struct ext_image_copy_capture_cursor_session_v1 *session,
                    int32_t x, int32_t y)
{ (void)session; pk_cursor_hotspot(data, x, y); }

static const struct ext_image_copy_capture_cursor_session_v1_listener events = {
    .enter = enter, .leave = leave, .position = position, .hotspot = hotspot,
};

struct pk_cursor *pk_cursor_create(struct ext_image_copy_capture_manager_v1 *manager,
    struct ext_image_capture_source_v1 *source, struct wl_pointer *pointer,
    uint32_t width, uint32_t height)
{
    if (!manager || !source || !pointer || !width || !height) return NULL;
    struct pk_cursor *c = calloc(1, sizeof(*c));
    if (!c) return NULL;
    c->source_width = width;
    c->source_height = height;
    c->pointer_session = ext_image_copy_capture_manager_v1_create_pointer_cursor_session(manager, source, pointer);
    if (!c->pointer_session) { free(c); return NULL; }
    if (ext_image_copy_capture_cursor_session_v1_add_listener(c->pointer_session, &events, c) < 0) {
        pk_cursor_destroy(c);
        return NULL;
    }
    c->image_session = ext_image_copy_capture_cursor_session_v1_get_capture_session(c->pointer_session);
    if (!c->image_session) { pk_cursor_destroy(c); return NULL; }
    return c;
}

struct ext_image_copy_capture_session_v1 *pk_cursor_image_session(struct pk_cursor *c)
{ return c->image_session; }

void pk_cursor_destroy(struct pk_cursor *c)
{
    if (!c) return;
    if (c->image_session) ext_image_copy_capture_session_v1_destroy(c->image_session);
    if (c->pointer_session) ext_image_copy_capture_cursor_session_v1_destroy(c->pointer_session);
    free(c->image);
    free(c);
}
