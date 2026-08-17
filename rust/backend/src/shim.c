/*
 * The C ABI between the Rust backend and the Lean decisions.
 *
 * Same shape and same reasons as `rust/day-shell/src/shim.c`, which this is
 * modelled on: Rust cannot call Lean directly because half of the runtime
 * interface is `static inline` in <lean/lean.h> — `lean_io_mk_world`,
 * `lean_io_result_is_ok`, `lean_dec_ref` and the string accessors have no
 * linkable symbols. Restating those inlines in Rust would duplicate a header
 * that is free to change under us; this file includes the real one.
 *
 * Three functions: initialise, call, free.
 */
#include <lean/lean.h>
#include <string.h>
#include <stdlib.h>

/* Emitted by `@[export health_backend_call]` in lean/BackendEntry.lean. Takes an
 * owned Lean string, returns an owned Lean string. */
extern lean_object *health_backend_call(lean_object *input);

/* Lake generates one per module, named after the PACKAGE and the module: the
 * package is `verified`, so `BackendEntry`'s is `initialize_verified_BackendEntry`.
 * It transitively initialises `Verified`, so it is the only one to call.
 *
 * Takes `builtin` alone — no world argument. Neither the name nor the arity is
 * guessable; both are read off `lean/.lake/build/ir/Main.c`, the generated
 * `main` this is a copy of. If a toolchain bump breaks it, diff against that
 * file again rather than reasoning about what the signature ought to be. */
extern lean_object *initialize_verified_BackendEntry(uint8_t builtin);

/* <lean/lean.h> does not declare it; Lean's own generated `main`
 * forward-declares it the same way. It lives in libleancpp. */
void lean_initialize(void);

/* 0 on success. Must be called once, before any other entry point here.
 *
 * This is `Main.c`'s `main` with the argv and task-running parts removed, and
 * the ORDER is its order: `lean_io_mark_end_initialization` runs BEFORE the
 * result is inspected, so a failed initialisation still leaves the runtime able
 * to print the error.
 *
 * `lean_init_task_manager` is not optional even though nothing called from here
 * is concurrent today — Lean's own `main` calls it before running any user
 * code, and a decision that used a `Task` internally would otherwise work until
 * the day it did. */
int health_backend_init(void) {
	lean_initialize();
	lean_object *res = initialize_verified_BackendEntry(1 /* builtin */);
	lean_io_mark_end_initialization();
	if (!lean_io_result_is_ok(res)) {
		lean_io_result_show_error(res);
		lean_dec_ref(res);
		return 1;
	}
	lean_dec_ref(res);
	lean_init_task_manager();
	return 0;
}

/* Returns a malloc'd copy the caller must pass to `health_backend_free`.
 *
 * The copy is not laziness. `lean_string_cstr` points INTO a Lean heap object,
 * and the `lean_dec_ref` below frees it — handing that pointer to Rust and
 * dropping the reference is a use-after-free that happens to work until the GC
 * runs. */
char *health_backend_json(const char *input) {
	lean_object *arg = lean_mk_string(input);
	lean_object *res = health_backend_call(arg);
	char *out = strdup(lean_string_cstr(res));
	lean_dec_ref(res);
	return out;
}

void health_backend_free(char *p) { free(p); }
