/*
 * The C ABI between the Rust host and the Lean fold.
 *
 * Rust cannot call Lean directly because half of Lean's runtime interface is
 * `static inline` in <lean/lean.h> — `lean_io_mk_world`, `lean_io_result_is_ok`,
 * `lean_dec_ref` and the string accessors have no linkable symbols. Rewriting
 * those inlines as Rust constants would be duplicating a header that is free to
 * change under us; this file includes the real one instead.
 *
 * Three functions, deliberately: initialise, call, free. The call takes and
 * returns a C string, which is the narrowest boundary that still carries a whole
 * day — no structs to keep in sync between three languages.
 */
#include <lean/lean.h>
#include <string.h>
#include <stdlib.h>

/* Emitted by `@[export health_day_result]` in lean/DayEntry.lean. Takes an owned
 * Lean string, returns an owned Lean string. */
extern lean_object *health_day_result(lean_object *input);

/* Lake generates one of these per module, named after the PACKAGE and the
 * module: the package is `verified`, so the `DayEntry` library's is
 * `initialize_verified_DayEntry`. It transitively initialises `Verified`, so it
 * is the only one to call.
 *
 * It takes `builtin` alone — no world argument. Neither the name nor the arity
 * is guessable, and both were wrong on the first attempt here; they are read off
 * `lean/.lake/build/ir/Main.c`, which is the generated `main` this function is a
 * copy of. If a toolchain bump breaks this, diff against that file again rather
 * than reasoning about what the signature ought to be. */
extern lean_object *initialize_verified_DayEntry(uint8_t builtin);

/* Declared here because <lean/lean.h> does not declare it — Lean's own generated
 * `main` forward-declares it the same way. It lives in libleancpp. */
void lean_initialize(void);

/* 0 on success. Must be called once, before any other entry point here.
 *
 * This is `Main.c`'s `main` with the argv and task-running parts removed, and
 * the ORDER is its order, not a tidied version: `lean_io_mark_end_initialization`
 * runs BEFORE the result is inspected, so a failed initialisation still leaves
 * the runtime in a state where the error can be printed.
 *
 * `lean_init_task_manager` is not optional even though nothing here is
 * concurrent. Lean's own `main` calls it before running any user code, and the
 * fold is free to use a `Task` internally — a host that skipped it would work
 * until the day some pass did. */
int health_shell_init(void) {
	lean_initialize();
	lean_object *res = initialize_verified_DayEntry(1 /* builtin */);
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

/* Returns a malloc'd copy the caller must pass to `health_shell_free`.
 *
 * The copy is not laziness. `lean_string_cstr` points INTO a Lean heap object,
 * and that object is freed by the `lean_dec_ref` below — handing the pointer to
 * Rust and dropping the reference would be a use-after-free that happens to
 * work until the GC runs. */
char *health_shell_day(const char *input) {
	lean_object *arg = lean_mk_string(input);
	lean_object *res = health_day_result(arg);
	char *out = strdup(lean_string_cstr(res));
	lean_dec_ref(res);
	return out;
}

void health_shell_free(char *p) { free(p); }

/* Lean object construction, for the host's `@[extern]` answers.
 *
 * The lookups themselves live in Rust — that is where the OSM reads will be —
 * but `lean_alloc_sarray` and `lean_dec` are `lean.h` inlines with no linkable
 * symbols, so Rust cannot call them directly. Same reason this file exists at
 * all. */
lean_object *health_shell_mk_bytes(const uint8_t *p, size_t n) {
	lean_object *a = lean_alloc_sarray(1, n, n);
	memcpy(lean_sarray_cptr(a), p, n);
	return a;
}

/* Release a boxed argument an `@[extern]` callee owns. A no-op for a tagged
 * scalar, which is what every radius this passes actually is. */
void health_shell_dec(lean_object *o) { lean_dec(o); }
