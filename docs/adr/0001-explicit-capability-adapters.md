# Use Explicit Capability Adapters Instead of a Generic Mapper

Status: accepted

The V5 mapper will be a closed-world registry of explicit capability adapters, supported by a generic execution engine for shared mechanics. A capability's semantic identity is authoritative even when its members have identical value shapes; bundle adapters are required when several capabilities or HomeKit services must coordinate. The plugin owns HomeKit representation and policy, while the SDK owns verified device truth and semantic metadata. This rejects a fully generic `describe()`-driven mapper because the SDK manifest cannot determine HomeKit service shape, polarity, enum translation, thresholds, instance identity, or convergence behavior without reintroducing capability-specific lookup tables.

Adapters are admitted only for reported, evidence-gated SDK members with verified wire truth. Readable members with unverified writes may produce read-only services, while unknown or unsupported capabilities are omitted with structured diagnostics. Persistent writes and momentary actions remain distinct; transport acknowledgment determines command success, device observations win reconciliation conflicts, and retryability is declared per operation.

HomeKit service bundling, component instance identity, names, thresholds, enum translation, and target/current convergence remain plugin concerns. The SDK is not extended merely to describe HomeKit presentation; SDK changes are warranted only for missing or withheld device truth such as verified motion state or semantic polarity.
