# Contact sensors

The V5 contact adapter maps verified SDK contact observations to HomeKit `ContactSensor` semantics with
explicit polarity and fault handling.

::: warning Not yet published by the production platform
The adapter and coverage evidence are implemented, but accessory creation/reconciliation is not yet
wired into the runtime platform. Do not expect a contact accessory in Apple Home yet.
:::

The adapter requires contact-specific SDK evidence. It does not infer contact meaning from an arbitrary
boolean property.
