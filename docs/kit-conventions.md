# Kit conventions

Adapted from BYOKit's kit conventions under Apache-2.0. These rules apply to new platform-kit code. Existing public
APIs and the binding [capability contracts](capability-kits.md) take precedence until an explicit spec change;
the scope move preserves every existing signature, native identifier and recorder protocol field.

## 1. Names

Packages are `@platform-kits/<name>` in `packages/<name>`, with capability names: overlay, statusbar, record,
speak, browser and social. The directory matches the npm suffix. Release tags are `<name>-v<version>`. The first scope
migration keeps the source versions. An unpublished kit is named before first publication.

## 2. Codes

Machine-readable codes are kebab-case string literals in a named union. They describe a situation without
embedding secrets, paths or identifiers. Wire formats retain their own protocol fields; recorder protocol v1
continues using its existing `event` field.

## 3. Errors

A failing kit has its named error class with a set `name` and readonly code union, exported from its main entry.
Person-facing words are selected from codes; messages and optional diagnostic detail never hold secrets. Expected
outcomes may use a documented result union. Programming mistakes use the built-in TypeError or RangeError where
the contract specifies them. Abort behavior follows the kit's documented signal contract. Existing error names,
fields and sanitized browser errors remain unchanged.

## 4. Results or throws

Reject with the kit error when failure stops an operation. Return a result union for expected outcomes handled on
every call, such as a declined screen capture or unsupported platform. Preserve the exact existing union shapes.

## 5. State

Long-lived integrations expose their documented state and changes. Stateless calls resolve or reject without
inventing a supervisor. Keep existing overlay/statusbar state unions and their native-free fallback behavior.

## 6. Events and streams

Subscriptions return their own unsubscribe function. A caller never needs to keep a listener reference to remove
it, and public APIs do not expose EventEmitter. Stepwise work is an AsyncIterable and follows its versioned
protocol discriminator; breaking iteration and AbortSignal handling follow the package contract.

## 7. Construction

Constructors take one typed options object and perform no I/O unless their existing spec says otherwise. Async
setup uses the documented factory. Native wrapper factories accept injected modules for tests; React Native
entries expose the native-backed instances and default entries stay portable. Pluggable backends use small
injection seams, never an implicit installed application.

## 8. Options

Use explicit app-owned inputs. Library code never reads process.env; spawned processes receive an environment
built from nothing plus the values the app supplies. Tests and tooling may read their own test configuration.
State directories are absolute and writes stay within the kit-owned folders. Secrets use restrictive permissions
and atomic writes where the contract requires them. New duration options use the Ms suffix, clocks return epoch
milliseconds, AbortSignal is per call, and diagnostics never contain secrets. Existing option names remain stable.

## 9. Words

Native-free words helpers and JSON keep the existing keys, exported WORDS/WordKey/words/stateWords/errorWords
surfaces where present. JSON imports use `with { type: 'json' }`. Missing interpolation slots remain visible as
`{key}`. Word tests check the kit's existing banned-jargon expression. Browser and speak retain their current
plain error sentences. Product copy and privacy claims belong to the app.

## 10. Export names

Give a name one shape across the ecosystem. Before adding an export, search packages/*/src for it. Kit-specific
concepts use distinct names instead of generic Code/State/Kind types. Preserve the scope migration's existing
exports and conditional browser/React Native/default boundaries.

## 11. Changing a public name

A later published export rename keeps a deprecated alias for at least one minor release with a changelog entry.
A signature change starts with the spec. Package renames update manifests, exact dependency pins, examples,
release order, build list and locks. Native scope changes require packed plugin and autolinking proof. Any old
package deprecation or shim is a separately authorized migration; the extraction does neither.
