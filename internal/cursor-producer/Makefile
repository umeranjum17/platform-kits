# SPDX-License-Identifier: Apache-2.0
CC ?= cc
PKGS = wayland-client libpipewire-0.3
CPPFLAGS += -D_POSIX_C_SOURCE=200809L -Ibuild $(shell pkg-config --cflags $(PKGS))
CFLAGS += -std=c11 -Wall -Wextra -Werror -O2
LDLIBS += $(shell pkg-config --libs $(PKGS))
PROTOCOLS = $(shell pkg-config --variable=pkgdatadir wayland-protocols)
COPY_XML = $(PROTOCOLS)/staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml
SOURCE_XML = $(PROTOCOLS)/staging/ext-image-capture-source/ext-image-capture-source-v1.xml

.PHONY: all check clean
all: build/libcursor-producer.a
build:
	mkdir -p $@
build/ext-image-copy-capture-v1-client-protocol.h: $(COPY_XML) | build
	wayland-scanner client-header $< $@
build/copy-protocol.c: $(COPY_XML) | build
	wayland-scanner private-code $< $@
build/source-protocol.c: $(SOURCE_XML) | build
	wayland-scanner private-code $< $@
build/wayland.o: wayland.c state.h cursor.h build/ext-image-copy-capture-v1-client-protocol.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@
build/%.o: %.c state.h cursor.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@
build/%-protocol.o: build/%-protocol.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@
build/libcursor-producer.a: build/state.o build/wayland.o build/pipewire.o build/copy-protocol.o build/source-protocol.o
	$(AR) rcs $@ $^
build/contract: contract.c build/libcursor-producer.a
	$(CC) $(CPPFLAGS) $(CFLAGS) $^ $(LDLIBS) -o $@
check: build/contract
	./build/contract
clean:
	rm -rf build
