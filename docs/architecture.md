# Architecture

V5 separates verified Eufy device truth from HomeKit policy and keeps one long-lived owner of the SDK
session. Its architecture is a closed graph of modules rather than a set of feature-specific paths to
the SDK.

## Runtime flow

```text
@mega-yfue/eufy-sdk
  -> persisted SDK adapter
     -> RuntimeOwner
        -> current runtime state
        -> versioned canonical registry view
        -> allowlisted persisted device snapshot
           -> custom UI and diagnostics
        -> HomeKit reconciler
           -> explicit capability and bundle adapters
              -> HomeKit services, characteristics, controllers, and media consumers
```

`RuntimeOwner` is the only long-lived SDK owner. It validates that a complete registry and its snapshot
contain the same entity serials, persists and publishes the snapshot, installs the registry view, and
only then enters `ready`.

The registry and runtime state are separate interfaces. The latest complete registry is retained while
the runtime is degraded, requires authentication, fails, stops, or is stopped so that a temporary
connection failure cannot mutate HomeKit topology. Runtime state determines whether operations are
currently available. A later complete inventory is the only input that may replace the view and
withdraw capability evidence.

Connectivity loss moves availability to `degraded`; a later connection schedules complete discovery,
and only successful complete publication restores `ready`. Session expiry, startup failure, process
signals, and Homebridge shutdown converge on one idempotent cleanup. Cleanup detaches SDK listeners,
bounds disconnect and lease release against one deadline, and never releases an acquired lease more
than once. Successful release finalizes the tracker inside the ownership guard after removing the old
owner and before a successor can acquire. A timeout still attempts the remaining cleanup and publishes
`failed` rather than leaving active runtime evidence behind.

Consumers can read the current registry view and subscribe to later complete versions. HomeKit defines
the minimal source interface it consumes; the platform composition root injects the structurally
compatible `RuntimeOwner`. HomeKit does not import or construct the runtime implementation.

The HomeKit reconciler keys accessory containers from the historical device UUID input `d1_<serial>`.
Routing facts and discovery order never participate in identity. An explicit primary-purpose adapter
must attach before a container is published; supplemental identity metadata can enrich that container
but cannot establish representation. Services use stable semantic adapter keys within the container.

## Module graph

```text
src/
  account/       account lease, persisted generations, temporary authentication
  device/        complete discovery and allowlisted snapshot vocabulary
  homekit/       coverage matrix, reconciler, explicit capability and bundle adapters
  media/         FFmpeg, live sessions, recording, talkback, and snapshot adaptation
  runtime/       long-lived owner, SDK adapter, canonical registry, status tracker
  ui/            Homebridge custom UI composition root
  configuration.ts
  platform.ts    Homebridge runtime composition root
  settings.ts
  storage.ts     stable persistence root and pre-rename V5 migration
  index.ts       package entry and platform registration only
```

Dependencies follow these directions:

| Source | Allowed internal dependencies |
| --- | --- |
| `device/` | None |
| `account/` | configuration, device |
| `runtime/` | account, configuration, device |
| `media/` | configuration, device |
| `homekit/` | device |
| `ui/server.ts` | account, configuration, device, persisted runtime views, storage |
| `platform.ts` | configuration, runtime, HomeKit, media, storage |
| `index.ts` | platform and settings |

V5 state lives under `homebridge-eufy` in the Homebridge storage directory. `storage.ts` atomically
adopts the earlier `eufy-security` V5 directory only when no live SDK owner holds it. If both roots
exist, startup fails rather than guessing which account generation is authoritative.

The contract suite rejects unlisted top-level modules, dependency edges, internal cycles, generic
sharing buckets, and internal barrels. A new module or edge is an architecture decision and therefore
requires a deliberate update to both this document and the executable contract.

Each HomeKit capability adapter is self-hosted in one file: its admission evidence, coverage rows,
stable keys, HAP attachment, observations, events, and diagnostics stay together. The adapter registry
only assembles those modules; the reconciler owns containers and complete-snapshot lifecycle, not
capability behavior.

## Composition roots

`platform.ts` and `ui/server.ts` are composition roots. They may see multiple modules to construct and
connect them, but they contain no domain behavior.

The runtime composition root connects account persistence, ownership, the long-lived SDK adapter,
registry publication, HomeKit reconciliation, and eventually media adapters. The UI composition root
connects the temporary authentication owner to account stores and reads allowlisted persisted runtime
views. It never reconstructs the SDK capability model.

Only `runtime/sdk-client.ts` and `ui/server.ts` may construct a concrete SDK client. Other modules may
consume public typed SDK capabilities relevant to their policy, but may not import SDK transports,
private package paths, or the client facade.

## Module design

Interfaces live beside the consumer that needs them. Implementations are injected structurally at a
composition root. This keeps each interface small and prevents a generic contracts layer from becoming
a second dependency hub.

Generic `common/`, `contracts/`, `shared/`, and `utils/` directories are forbidden. Shared behavior
belongs to the domain that owns its invariant. Internal barrels are also forbidden; the package entry
point and closed registries such as the capability adapter registry are deliberate exceptions.

Behavior is tested through public module seams in `test/contracts/`. Tests stay independent from
private helper structure and use synthetic typed SDK fakes, real HAP definitions where relevant, and no
account or network access.

## Ownership boundaries

- The SDK owns verified device capabilities, observations, operations, events, and transport behavior.
- The plugin owns Homebridge lifecycle, accessory identity, HomeKit representation, configuration,
  diagnostics, and media adaptation.
- A missing SDK fact is an SDK gap and is never guessed in the plugin.
- Partial inventory updates change included evidence only. Only a complete snapshot may withdraw
  capability evidence.
- Successful command delivery is not a physical device observation.
- The runtime registry is the only in-process source of operational SDK devices.
- The persisted snapshot is an allowlisted read model for UI and diagnostics, not a second operational
  registry.

## Media boundary

Media adaptation is a separate plugin module because source acquisition and HomeKit output have
different contracts and lifetimes. The SDK supplies Eufy source truth. `media/` owns FFmpeg, negotiated
output, snapshots, live sessions, talkback, HKSV fragments, prebuffer, and resource budgets.

HomeKit camera bundles define the media interfaces they consume. The platform composition root injects
the media implementations. This prevents camera tickets from embedding independent process, source,
and cleanup policies in each HomeKit adapter.
