# Contact sensors

The V5 contact adapter maps verified SDK contact observations to HomeKit `ContactSensor` semantics with
explicit polarity and fault handling.

The production platform publishes one stable accessory container per represented SDK entity serial.
Contact services retain the semantic `contact.sensor` key when complete runtime snapshots refresh.

The adapter requires contact-specific SDK evidence. It does not infer contact meaning from an arbitrary
boolean property. Recognized devices without that primary-purpose evidence remain visible only in the
dashboard and diagnostics.
