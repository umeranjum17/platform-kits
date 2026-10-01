/* SPDX-License-Identifier: Apache-2.0 */
#include "state.h"
#include <errno.h>
#include <pipewire/pipewire.h>
#include <spa/param/buffers.h>
#include <spa/pod/builder.h>

int pk_cursor_negotiate(struct pw_stream *stream)
{
    if (!stream) return -EINVAL;
    unsigned char storage[256];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
    const struct spa_pod *params[] = {
        spa_pod_builder_add_object(&builder,
            SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta,
            SPA_PARAM_META_type, SPA_POD_Id(SPA_META_Cursor),
            SPA_PARAM_META_size, SPA_POD_Int(PK_CURSOR_META_SIZE)),
    };
    return pw_stream_update_params(stream, params, 1);
}
