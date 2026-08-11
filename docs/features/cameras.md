# Cameras, streaming, and HKSV

::: danger Not yet available in V5
Camera representation, live streaming, snapshots, talkback, and HomeKit Secure Video are still being
rebuilt. Legacy V4 settings do not apply to V5.
:::

The planned V5 media contract keeps SDK source truth separate from HomeKit adaptation:

- SDK video and audio remain separate inputs.
- HomeKit negotiation, transcoding, RTP/SRTP, RTCP, AAC-ELD, and recording policy belong to the plugin.
- Silent or unavailable camera audio must not block video.
- Battery devices are not kept awake merely to manufacture prebuffer.
- Stored-only and live snapshots remain distinct acquisition policies.

For historical settings only, see [legacy V4 streaming](/legacy/v4/streaming).
