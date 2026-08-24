# Cameras, streaming, and HKSV

::: warning Closed-beta behavior
Camera representation, live streaming, snapshots, talkback, and HomeKit Secure Video are available to
the V5 closed beta. Legacy V4 settings do not apply to V5.
:::

The V5 media contract keeps SDK source truth separate from HomeKit adaptation:

- SDK video and audio remain separate inputs.
- HomeKit negotiation, transcoding, RTP/SRTP, RTCP, AAC-ELD, and recording policy belong to the plugin.
- Silent or unavailable camera audio must not block video.
- Battery devices are not kept awake merely to manufacture prebuffer.
- Stored-only and live snapshots remain distinct acquisition policies.
- Talkback opens one SDK handle only after HomeKit return audio is decoded, and its failure does not stop
  outbound video or audio.

For historical settings only, see [legacy V4 streaming](/legacy/v4/streaming).
