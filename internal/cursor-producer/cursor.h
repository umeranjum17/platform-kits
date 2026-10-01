/* SPDX-License-Identifier: Apache-2.0 */
#ifndef PLATFORM_KITS_CURSOR_H
#define PLATFORM_KITS_CURSOR_H

#include <stdbool.h>
#include <stdint.h>
#include <spa/buffer/buffer.h>

struct ext_image_copy_capture_manager_v1;
struct ext_image_capture_source_v1;
struct ext_image_copy_capture_session_v1;
struct wl_pointer;
struct pw_stream;
struct pk_cursor;

/* Borrow objects from the portal's existing Wayland connection. source MUST be
 * the same object used for the cursor-free main capture. No socket is opened.
 * width/height are the main image's TRANSFORMED buffer pixel dimensions.
 * Calls, Wayland dispatch, and stream queueing must share one serialized thread.
 * This internal adapter is experimental; it does not advertise portal support.
 */
struct pk_cursor *pk_cursor_create(
    struct ext_image_copy_capture_manager_v1 *manager,
    struct ext_image_capture_source_v1 *source, struct wl_pointer *pointer,
    uint32_t width, uint32_t height);
void pk_cursor_destroy(struct pk_cursor *cursor);

/* Borrowed cursor-image capture session. Reuse the portal's ordinary SHM capture
 * code to negotiate constraints and capture actual cursor frames on this session.
 * The caller owns frame objects/buffers, NOT the returned session object.
 */
struct ext_image_copy_capture_session_v1 *pk_cursor_image_session(struct pk_cursor *cursor);

/* Call ONLY on cursor-image frame.ready, using its captured bytes and presentation
 * time. Supported here: normal-transform wl_shm ARGB8888/XRGB8888 on little-endian
 * systems. Unsupported image transforms/formats fail closed. Transparent ARGB
 * means invisible. hotspot is applied at ready, never when its event arrives.
 */
int pk_cursor_image_ready(struct pk_cursor *cursor, const void *pixels, size_t length,
                         uint32_t width, uint32_t height, uint32_t stride,
                         uint32_t wl_shm_format, uint32_t transform,
                         int64_t presentation_ns);
void pk_cursor_stop(struct pk_cursor *cursor);

/* Add alongside the portal's existing buffer/format/header parameters, once it
 * has a stream. Does not connect/create/queue a PipeWire stream or change pixels.
 */
int pk_cursor_negotiate(struct pw_stream *stream);

/* Write into a DEQUEUED buffer from the portal-owned stream immediately before
 * queueing. Never rewrites SPA_META_Header/PTS: cursor/frame observation clocks
 * remain the consumer's responsibility. Returns 1 for a new real sample, 0 for
 * id=0 (no change), negative errno for unavailable/undersized metadata. A sample
 * is acknowledged only after the caller has successfully queued the buffer.
 */
struct pk_cursor_provenance {
    uint64_t revision;
    int64_t observed_monotonic_ns;
    int64_t image_presentation_ns;
    int32_t x, y;
    bool visible;
};
int pk_cursor_write(struct pk_cursor *cursor, struct spa_buffer *buffer,
                    struct pk_cursor_provenance *provenance);
void pk_cursor_queued(struct pk_cursor *cursor, uint64_t revision);

#endif
