# Hardware encoder viability for negotiated live streams

## The question

Should live-stream adaptation probe for and use a hardware H.264 encoder instead of always using
`libx264 -preset ultrafast -tune zerolatency`?

This file records evidence only. The decision it supports is recorded under "Live adaptation encoder" in
[the architecture](../architecture.md): hardware encoding is excluded, and the two conditions that would
reopen it are stated there.

## What the plugin currently promises

`videoArguments` in `src/media/live-stream.ts:353` builds one argument list per adaptation process. From the
HomeKit-negotiated `NegotiatedLiveVideo` (`src/media/live-stream.ts:48`) it passes `-profile:v` as one of
`baseline`, `main`, `high`; `-level:v` as one of `3.1`, `3.2`, `4.0`; `-r <fps>`; and
`-b:v <n>k -maxrate <n>k -bufsize <2n>k`. It also passes `-pix_fmt yuv420p` and a software
`scale`/`pad` filter chain, and it feeds Annex-B video on `pipe:0`.

The executable is host-dependent: `src/configuration.ts:136` resolves `ffmpegPath` to the configured path
if present, otherwise to the `ffmpeg-for-homebridge` bundled binary. Nothing in `src/` names an encoder or
probes one.

## Summary of findings

Of the seven encoders named in the question, four cannot express the profile or the level the plugin passes
today, one does not exist upstream, and on Linux only one of the remaining ones is present in the bundled
binary at all.

- Swapping `-c:v libx264` for a hardware encoder is not a one-token change. Each encoder spells `-profile:v`
  and `-level:v` differently, several drop one of them silently, and the surface encoders (`h264_vaapi`,
  `h264_qsv`) also require a hardware device, a different filter graph, and no `-pix_fmt yuv420p`.
- `h264_v4l2m2m` — the only hardware H.264 encoder present in every published `ffmpeg-for-homebridge` Linux
  artifact — rejects `-profile:v main` outright, never reads `-level:v` at all, and has no equivalent for
  `-maxrate`, `-bufsize`, `-preset`, or `-tune`.
- `h264_vaapi` and `h264_amf` have no `baseline` spelling. `h264_qsv` and `h264_v4l2m2m` have no private
  `level` option, so `-level:v 3.1` is evaluated as the arithmetic expression `3.1` and truncated to `3`.
- The bundled binary ships no VAAPI, QSV, or NVENC encoder on Linux. Distribution ffmpeg does, but
  enumeration is not availability: every hardware encoder on this host enumerates and every one fails to
  open.
- `h264_rkmpp` does not exist as an encoder in upstream FFmpeg 7.1 or 8.0.

## 1. Contract fidelity

### How FFmpeg resolves `-profile:v` and `-level:v`

`AVCodecContext` defines generic `profile` and `level` options. Both are `AV_OPT_TYPE_INT`, and the only
named constant either of them carries is `unknown` (`libavcodec/options_table.h:224` and
`options_table.h:227` at FFmpeg n7.1; the generic `level` entry in
<https://ffmpeg.org/ffmpeg-codecs.html#Codec-Options> lists `unknown` as its sole possible value).

An encoder may shadow these with private options. `av_opt_find2` searches an object's children before the
object's own option table when `AV_OPT_SEARCH_CHILDREN` is set (`libavutil/opt.c`, `av_opt_find2`), so a
private `profile`/`level` always wins over the generic one. The libx264 documentation states this
explicitly for `level`: "Alternatively it can be set as a private option, overriding the value set in
`AVCodecContext`, and in this case must be specified as the level IDC identifier (e.g. "3.1")"
(<https://ffmpeg.org/ffmpeg-codecs.html#libx264_002c-libx264rgb>).

The consequence matters. When an encoder has **no** private `level` option, `-level:v 3.1` reaches the
generic integer option, whose string parser evaluates the value as an arithmetic expression and rounds it
(`libavutil/opt.c`, `set_string_number` then `write_number`). `3.1` becomes `3`, which is not a valid H.264
`level_idc`. This-host confirmation with an encoder that uses the generic path: `-level:v 3.1` produced a
coded `level=3`, while `-level:v 31` produced a different value entirely.

### Per encoder

| Encoder             | HomeKit profiles    | HomeKit levels | Bitrate ceiling  | Preset | Tune |
| ------------------- | ------------------- | -------------- | ---------------- | ------ | ---- |
| `libx264`           | all three           | as spelled     | VBV              | yes    | yes  |
| `h264_v4l2m2m`      | none as spelled     | ignored        | none             | no     | no   |
| `h264_vaapi`        | no `baseline`       | as spelled     | driver-dependent | no     | no   |
| `h264_qsv`          | all three           | mis-parsed     | CBR if granted   | yes    | no   |
| `h264_nvenc`        | all three           | as spelled     | needs `-rc cbr`  | yes    | yes  |
| `h264_videotoolbox` | all three           | as spelled     | via `maxrate`    | no     | yes  |
| `h264_amf`          | no `baseline`       | as spelled     | CBR              | yes    | yes  |
| `h264_omx`          | all three           | ignored        | none             | no     | no   |
| `h264_rkmpp`        | no upstream encoder | n/a            | n/a              | n/a    | n/a  |

HomeKit profiles is whether `baseline`, `main`, and `high` can all be spelled on the command line the way
the plugin spells them today. HomeKit levels is whether `-level:v 3.1`, `3.2`, and `4.0` reach the encoder
with the intended value. Bitrate ceiling is whether the encoder can be made to honour a hard cap at all.
Every row is justified below.

#### `libx264` (the current encoder)

`profile`, `level`, `preset`, and `tune` are all private options. The plugin's spellings are all valid.
The known caveat is not a fidelity failure but a substitution the encoder is entitled to make: `ultrafast`
plus `zerolatency` disables CABAC and the 8x8 transform, so x264 marks the stream at the profile the
retained feature set actually requires. This-host reproduction with the plugin's exact video argument shape
at 1280x720@30 and `-profile:v main -level:v 3.1` yielded `profile=Constrained Baseline`, `level=31`,
`1280x720`. The negotiated level and dimensions are honoured; the coded profile is at or below the
requested one.

#### `h264_v4l2m2m`

This is the weakest of the set against the plugin's contract, and it is also the only hardware H.264
encoder present in every published `ffmpeg-for-homebridge` Linux artifact.

- **Profile.** The encoder's `AVOption` table is `V4L_M2M_CAPTURE_OPTS` only — two buffer-count options and
  nothing else (`libavcodec/v4l2_m2m_enc.c:403`, and `M2MENC(h264, "H.264", options, AV_CODEC_ID_H264)` at
  `v4l2_m2m_enc.c:444` uses that table rather than the MPEG-4 one with profile constants). So `-profile:v`
  falls to the generic integer option, which has no `main` constant. This-host result with the plugin's
  argument shape: `Undefined constant or missing '(' in 'main'`, then
  `Error applying encoder options: Invalid argument`.
  A numeric `-profile:v 77` parses. The wrapper then maps `avctx->profile` to
  `V4L2_CID_MPEG_VIDEO_H264_PROFILE`, and when the mapping fails it logs only
  `h264 profile not found` at `AV_LOG_WARNING` and continues (`v4l2_m2m_enc.c:209`).
- **Level.** `avctx->level` does not appear anywhere in `v4l2_m2m_enc.c`. The kernel defines
  `V4L2_CID_MPEG_VIDEO_H264_LEVEL` — "The level information for the H264 video elementary stream.
  Applicable to the H264 encoder" (<https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/ext-ctrls-codec.html>) —
  and the wrapper never sets it. `-level:v` is discarded entirely, and on the way to being discarded it is
  also mis-parsed to `3` by the generic integer option.
- **Bitrate.** `v4l2_prepare_encoder` sets exactly `V4L2_CID_MPEG_VIDEO_HEADER_MODE`,
  `V4L2_CID_MPEG_VIDEO_BITRATE` from `avctx->bit_rate`, `V4L2_CID_MPEG_VIDEO_FRAME_RC_ENABLE`,
  `V4L2_CID_MPEG_VIDEO_GOP_SIZE`, the H.264 profile, and min/max QP, and nothing else
  (`v4l2_m2m_enc.c`, `v4l2_prepare_encoder`).
  The kernel describes `V4L2_CID_MPEG_VIDEO_BITRATE` as "Average video bitrate in bits per second". The
  controls that would express a ceiling — `V4L2_CID_MPEG_VIDEO_BITRATE_PEAK`,
  `V4L2_CID_MPEG_VIDEO_BITRATE_MODE`, `V4L2_CID_MPEG_VIDEO_H264_CPB_SIZE` — are never set. `-maxrate` and
  `-bufsize` are never read.
- **Frame rate.** Honoured, via `VIDIOC_S_PARM` `timeperframe` from `avctx->framerate`
  (`v4l2_m2m_enc.c:192`).
- **Preset/tune.** No equivalent exists. This-host `-h encoder=h264_v4l2m2m` on both the Debian 7.1.5 build
  and the bundled 8.0 build lists only `-num_output_buffers` and `-num_capture_buffers`.

#### `h264_vaapi`

- **Profile.** The private option carries `constrained_baseline`, `main`, `high`, `high10`
  (`libavcodec/vaapi_encode_h264.c:1107`). There is no `baseline`. This-host:
  `-profile:v baseline` gives `Undefined constant or missing '(' in 'baseline'`. A numeric
  `AV_PROFILE_H264_BASELINE` is accepted and then silently rewritten: "H.264 baseline profile is not
  supported, using constrained baseline profile instead." at `AV_LOG_WARNING`
  (`vaapi_encode_h264.c:1004`).
- **Level.** Private integer with named `3.1`/`3.2`/`4.0` constants (`vaapi_encode_h264.c:1113`), and the
  FFmpeg documentation states "`level` sets the value of `level_idc`"
  (<https://ffmpeg.org/ffmpeg-codecs.html#VAAPI-encoders>). Values wider than 8 bits are a hard error
  (`vaapi_encode_h264.c:1029`).
- **Bitrate.** `b`, `maxrate`, `bufsize` are all documented as used. The rate-control mode is
  auto-selected, and CBR is only attempted when `avctx->rc_max_rate == avctx->bit_rate`
  (`libavcodec/vaapi_encode.c:1275`); if the driver does not advertise CBR the selection falls through to
  AVBR, VBR, then CQP (`vaapi_encode.c:1278`). The plugin already passes `-b:v` equal to `-maxrate`, so CBR
  would be requested, but whether it is granted is a driver property.
- **Preset/tune.** Neither exists. The nearest knobs are `-rc_mode`, `-compression_level` ("Speed / quality
  tradeoff"), and `-low_power`.
- **Additional shape change.** The encoder accepts only `AV_PIX_FMT_VAAPI`
  (`vaapi_encode_h264.c`, `ff_h264_vaapi_encoder.p.pix_fmts`), and the documentation says "These encoders
  only accept input in VAAPI hardware surfaces. If you have input in software frames, use the `hwupload`
  filter." This-host, feeding the plugin's existing `-pix_fmt yuv420p` plus `scale`/`pad` chain failed with
  `Impossible to convert between the formats supported by the filter`, naming the plugin's `pad` filter and
  the inserted auto-scaler. Using this encoder means a different filter graph plus an
  `-init_hw_device`/`-vaapi_device` argument, not a different `-c:v` token.
- **B-frames.** The encoder's defaults set `bf` to `2` (`vaapi_encode_h264.c`, `vaapi_encode_h264_defaults`),
  so B-frames are on unless `-bf 0` is passed.

#### `h264_qsv`

- **Profile.** Private integer with `baseline`, `main`, `high` (`libavcodec/qsvenc_h264.c:152`), assigned to
  `mfx.CodecProfile` (`libavcodec/qsvenc.c:721`). All three plugin spellings parse.
- **Level.** There is no private `level` option — confirmed both by this-host
  `-h encoder=h264_qsv` (no `-level` row) and by the source, which reads the generic field directly:
  `q->param.mfx.CodecLevel = avctx->level` (`qsvenc.c:720`, `qsvenc.c:790`). `-level:v 3.1` therefore sets
  `CodecLevel = 3`. The plugin would have to pass `-level:v 31`. Worse, `check_enc_param` enumerates
  mismatches for codec, profile, rate-control mode, frame rate, picture structure, resolution, and pixel
  format, but **not** for `CodecLevel` (`qsvenc.c:675`), so a wrong level produces no diagnostic.
- **Bitrate.** Documented: "CBR - constant bitrate, when `maxrate` is specified and equal to the average
  bitrate" (<https://ffmpeg.org/ffmpeg-codecs.html#QSV-Encoders>), which matches the plugin's arguments.
  `TargetKbps`, `MaxKbps`, `BufferSizeInKB` come from `b`, `maxrate`, `bufsize` (`qsvenc.c:913`). The same
  documentation warns "depending on your system, a different mode than the one you specified may be selected
  by the encoder."
- **Preset/tune.** `-preset veryfast` through `veryslow` exists and maps to `TargetUsage`. There is no
  `tune`; the nearest are `-scenario livestreaming`/`videoconference`, `-low_delay_brc`, and leaving
  `-look_ahead` off.
- **Additional shape change.** Pixel formats are `nv12` and `qsv` only, so `-pix_fmt yuv420p` must go.

#### `h264_nvenc`

- **Profile.** Private integer with `baseline`, `main`, `high`, `high444p`. Note that the encoder forces
  `high444p` when the input is `yuv444` regardless of the request (`libavcodec/nvenc.c:1307`).
- **Level.** Private integer with named `3.1`/`3.2`/`4.0` constants (`libavcodec/nvenc_h264.c:66`), assigned
  to `h264->level` (`nvenc.c:1315`). The plugin's spelling works.
- **Bitrate.** `averageBitRate` from `b`, `maxBitRate` from `maxrate`, `vbvBufferSize` from `bufsize`
  (`nvenc.c:1040`, `nvenc.c:1046`, `nvenc.c:1121`). Rate control is **not** inferred from
  `b == maxrate`: with `ctx->rc` unset, CBR is chosen only if the `-cbr` boolean is set, ConstQP if `-qp` is
  set, VBR if `-cq` is set, and otherwise whatever the selected preset supplied (`nvenc.c:1057`). Getting a
  hard ceiling therefore requires an explicit `-rc cbr` or `-cbr 1`.
- **Preset/tune.** `-preset p1`..`p7`, `-tune hq|ll|ull|lossless`, plus a dedicated
  `-zerolatency` boolean.

#### `h264_videotoolbox`

- **Profile and level.** Private integers, but they are resolved together through a fixed table rather than
  independently (`libavcodec/videotoolboxenc.c:808`, `get_vt_h264_profile_level`). All three HomeKit levels
  exist for `baseline`, `main`, and `high`: `kVTProfileLevel_H264_Baseline_3_1`/`_3_2`/`_4_0`,
  `Main_3_1`/`_3_2`/`_4_0`, `High_3_1`/`_3_2`/`_4_0`. An unmapped combination is a hard failure
  (`Invalid Profile/Level.`). Two profiles ignore the level and warn: `constrained_baseline` and
  `constrained_high` are forced to `AutoLevel` with "Level is auto-selected when constrained-baseline
  profile is used. The output may be encoded with a different level."
- **Bitrate.** `-b:v` becomes `kVTCompressionPropertyKey_AverageBitRate` (`videotoolboxenc.c:1262`), which
  Apple documents as "The long-term desired average bit rate in bits per second" and, in the Discussion,
  "This value is not a hard limit; the bit rate may peak above this."
  (<https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_averagebitrate>).
  `-maxrate` becomes `kVTCompressionPropertyKey_DataRateLimits` as `maxrate/8` bytes over one second
  (`videotoolboxenc.c:1283`); Apple documents that key as "Zero, one, or two hard limits on data rate"
  (<https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_dataratelimits>). A true
  CBR request needs `-constant_bit_rate 1`, which maps to `kVTCompressionPropertyKey_ConstantBitRate`
  ("Requires that the encoder use a Constant Bit Rate algorithm", macOS 13 or newer) and hard-errors with
  `AVERROR_EXTERNAL` if the encoder does not support it (`videotoolboxenc.c:1252`). `-bufsize` is not read.
  Both Apple bitrate keys carry the same caveat: "bit rate settings only have an effect when timing
  information is provided for source frames."
- **Frame rate.** The wrapper never sets `kVTCompressionPropertyKey_ExpectedFrameRate` — the symbol does not
  appear in `videotoolboxenc.c`. The output frame rate is still enforced by ffmpeg's own frame-rate
  conversion ahead of the encoder, but the encoder is not told the frame rate for rate-control purposes.
- **Preset/tune.** There is no `-preset`. `-realtime` maps to `kVTCompressionPropertyKey_RealTime`, and
  `-prio_speed` to `kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality` ("A hint for the video
  encoder to maximize its speed during encoding, sacrificing quality if needed"). Apple documents RealTime's
  default as "By default, this property is NULL, indicating unknown", but the FFmpeg wrapper defaults
  `realtime` to `0` and applies it whenever the value is `>= 0` (`videotoolboxenc.c:1533`), so the wrapper
  explicitly sets RealTime **false** unless `-realtime 1` is passed.

#### `h264_amf`

Not in the original list, but it is the only hardware H.264 encoder besides `h264_v4l2m2m` in the bundled
Linux x86_64 binary, so it is a realistic candidate on that platform.

- **Profile.** Private integer with `main`, `high`, `constrained_baseline`, `constrained_high`
  (`libavcodec/amfenc_h264.c:42`). There is no `baseline`. This-host on the bundled binary:
  `-profile:v baseline` gives `Undefined constant or missing '(' in 'baseline'`.
- **Level.** Private integer with named `3.1`/`3.2`/`4.0` constants (`amfenc_h264.c:49`). Note the
  precedence: `profile_level = avctx->level`, falling back to the private `ctx->level` only when the generic
  field is unknown (`amfenc_h264.c:255`). Because the private option shadows the generic one on the command
  line, `-level:v 3.1` reaches `ctx->level` and works; a caller setting `AVCodecContext.level`
  programmatically would take the other branch.
- **Bitrate.** CBR is auto-selected when `avctx->bit_rate > 0 && avctx->rc_max_rate == avctx->bit_rate`
  (`amfenc_h264.c:297`), and `-bufsize` maps to `AMF_VIDEO_ENCODER_VBV_BUFFER_SIZE` (`amfenc_h264.c:338`).
  This is the closest match to the plugin's existing bitrate arguments of any hardware encoder here.
- **Preset/tune.** `-usage ultralowlatency|lowlatency`, `-latency`, `-preset speed|balanced|quality`.

#### `h264_omx`

- **Profile.** Private integer with `baseline`, `main`, `high` (`libavcodec/omx.c:924`), mapped to
  `OMX_VIDEO_AVCProfileBaseline`/`Main`/`High` (`omx.c:535`). An unmapped value falls through
  `default: break` with no diagnostic.
- **Level.** `eLevel` is never assigned anywhere in `omx.c`. `-level:v` is ignored.
- **Bitrate.** `eControlRate` is hardcoded to `OMX_Video_ControlRateVariable` with
  `nTargetBitrate = avctx->bit_rate` (`omx.c:521`). There is no way to request CBR and no ceiling;
  `-maxrate` and `-bufsize` are unread. A failure to set it is a warning, not an error.
- **Frame rate.** Honoured via `xFramerate` (`omx.c:484`).
- **Preset/tune.** Neither exists.

#### `h264_rkmpp`

There is no `h264_rkmpp` encoder in upstream FFmpeg. The `libavcodec` tree at tag `n7.1` and at tag `n8.0`
contains `rkmppdec.c` and no encoder counterpart, and `libavcodec/allcodecs.c` at `n8.0` declares
`ff_h264_mediacodec_encoder`, `ff_h264_amf_encoder`, `ff_h264_mf_encoder`, `ff_h264_nvenc_encoder`,
`ff_h264_omx_encoder`, `ff_h264_qsv_encoder`, `ff_h264_v4l2m2m_encoder`, `ff_h264_vaapi_encoder`,
`ff_h264_videotoolbox_encoder`, and `ff_h264_vulkan_encoder` — no rkmpp entry. An `h264_rkmpp` encoder
exists only in downstream Rockchip forks, which are outside the primary-source scope of this file and were
not evaluated.

## 2. Low-latency behaviour

`-tune zerolatency` has no portable equivalent. What each encoder offers:

| Encoder             | Zero-latency control                                           |
| ------------------- | -------------------------------------------------------------- |
| `libx264`           | `-tune zerolatency`                                            |
| `h264_v4l2m2m`      | none; B-frames are forced to 0 by the wrapper                  |
| `h264_vaapi`        | `-bf 0` (default `2`), `-async_depth 1` (default `2`)          |
| `h264_qsv`          | `-bf 0`, `-look_ahead 0`, `-low_delay_brc 1`, `-async_depth 1` |
| `h264_nvenc`        | `-tune ull`, `-zerolatency 1`, `-rc-lookahead 0`, `-bf 0`      |
| `h264_videotoolbox` | `-realtime 1`, `-prio_speed 1`                                 |
| `h264_amf`          | `-usage ultralowlatency`, `-latency 1`, `-async_depth 1`       |
| `h264_omx`          | none; B-frames are forced to 0 by the wrapper                  |

Details worth noting for a live view:

- `h264_v4l2m2m` writes `V4L2_CID_MPEG_VIDEO_B_FRAMES = 0`, reads it back, and returns
  `AVERROR_PATCHWELCOME` if the driver refused (`libavcodec/v4l2_m2m_enc.c`, `v4l2_check_b_frame_support`).
  So B-frames are never a risk here, but neither is there any latency knob.
- `h264_vaapi` defaults `bf` to `2` and the encoder advertises `FF_HW_FLAG_B_PICTURES`
  (`vaapi_encode_h264.c:960`), so B-frame reordering delay is the default unless `-bf 0` is passed.
  `-async_depth` is documented as "Maximum processing parallelism. Increase this to improve single channel
  performance", i.e. it trades latency for throughput.
- `h264_qsv` defaults `-async_depth` to `4`, documented as "Specifies how many asynchronous operations an
  application performs before the application explicitly synchronizes the result", and the QSV decoder
  documentation states plainly that "the higher the value the higher the latency".
- `h264_nvenc`'s `-zerolatency` sets `rcParams.zeroReorderDelay = 1` (`nvenc.c:1187`), separate from
  `-tune ull` which sets `tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`. Both exist and do different
  things.
- `h264_videotoolbox` only sets `kVTCompressionPropertyKey_AllowFrameReordering` to false when
  `has_b_frames` is zero (`videotoolboxenc.c:1509`), which holds when `-bf 0` (the generic default). Apple
  documents `RealTime` as a recommendation, not a guarantee: "clients may set this property to true to
  recommend that encoding stay timely."
- `h264_amf` defaults `-async_depth` to `16`, whose own help text says "Higher values increase output
  latency."

## 3. Availability in practice

### `ffmpeg-for-homebridge`

The package's own README states the policy: "We also provide pragmatic hardware acceleration support where
it can be compiled in statically (V4L2M2M on Linux, VideoToolbox on macOS, and QSV on Windows only)", and
"Intel Quick Sync Video is only supported on Windows. If you need QSV or other GPU acceleration
capabilities on Linux, we recommend looking at the Jellyfin FFmpeg distribution"
(`node_modules/ffmpeg-for-homebridge/README.md`, and
<https://github.com/homebridge/ffmpeg-for-homebridge#readme>).

The build script agrees. In `build-ffmpeg` at tag `v2.2.2`, the whole QSV and VAAPI block is commented out
with the note "Unfortunately, libva is broken in static builds of FFmpeg, making QSV out of reach for the
time being" (line 1318), and the live VAAPI branch is guarded by `if [ -z "${LDEXEFLAGS}" ]` with the
comment "Vaapi doesn't work well with static links FFmpeg" (line 1380). NVENC requires `nvcc` on the build
host and otherwise the script passes `--disable-ffnvcodec` (line 1377). `--enable-amf` is added only for
`isLinux && TARGET_ARCH == x86_64` (line 1406). `--enable-omx-rpi` is added only when
`TARGET_OS == raspbian` (line 519).

`Dockerfile.linux` runs the build as `/build-ffmpeg --build --enable-gpl-and-non-free --full-static`, which
sets `LDEXEFLAGS="-static"` (line 399) and therefore takes the "no VAAPI" branch. The published targets in
`.github/workflows/build.yml` are `alpine-aarch64`, `alpine-arm32v7`, `alpine-x86_64`, `darwin-arm64`,
`darwin-x86_64`, and `windows-x86_64`. There is no `raspbian` target, so `h264_omx` is never built. (The
release also carries a FreeBSD asset, which the README attributes to a separate build script.)

Verified against the actual release artifacts of `v2.2.2` rather than the script:

| Artifact                       | Configure flags of note | H.264 hardware encoders    |
| ------------------------------ | ----------------------- | -------------------------- |
| `ffmpeg-alpine-x86_64.tar.gz`  | `--enable-amf`, static  | `h264_amf`, `h264_v4l2m2m` |
| `ffmpeg-alpine-aarch64.tar.gz` | no `amf`, static        | `h264_v4l2m2m`             |
| `ffmpeg-alpine-arm32v7.tar.gz` | no `amf`, static        | `h264_v4l2m2m`             |
| `ffmpeg-darwin-arm64.tar.gz`   | `--enable-videotoolbox` | `h264_videotoolbox`        |

No Linux artifact contains `h264_vaapi`, `h264_qsv`, `h264_nvenc`, or `h264_omx`. `h264_v4l2m2m` is present
without an explicit configure flag because FFmpeg enables the V4L2 mem2mem wrappers by default when
`linux/videodev2.h` is available, which the Alpine build image supplies via `linux-headers`
(`Dockerfile.linux:39`).

The README also states two platform limits that bear directly on `h264_v4l2m2m`'s value: hardware
acceleration is advertised for "Raspberry Pi 4 using `h264_v4l2m2m`", and "Raspberry Pi 5 is currently
unsupported." That matches the hardware. The Raspberry Pi 4 Model B product brief lists "H.264 (1080p60
decode, 1080p30 encode)" — a single 1080p30 encode budget. The Raspberry Pi 5 product brief's feature list
contains "4Kp60 HEVC decoder" and no encoder of any kind
(<https://datasheets.raspberrypi.com/rpi4/raspberry-pi-4-product-brief.pdf>,
<https://datasheets.raspberrypi.com/rpi5/raspberry-pi-5-product-brief.pdf>).

### This-host evidence

Bundled binary at `node_modules/ffmpeg-for-homebridge/ffmpeg`, downloaded as
`v2.2.2-ffmpeg-alpine-x86_64.tar.gz`:

```
ffmpeg version 8.0-homebridge-alpine-x86_64-static
libx264, libx264rgb, h264_amf, h264_v4l2m2m
hwaccels: amf
```

System binary at `/usr/bin/ffmpeg`, Debian 13:

```
ffmpeg version 7.1.5-0+deb13u1
libx264, libx264rgb, h264_nvenc, h264_qsv, h264_v4l2m2m, h264_vaapi, h264_vulkan
hwaccels: vdpau, cuda, vaapi, qsv, drm, opencl, vulkan
```

The Debian build's own configure string includes `--enable-libvpl` (which is why `h264_qsv` is present),
`--disable-libmfx` (the superseded MSDK path), `--enable-libdrm`, and `--disable-omx` (which is why
`h264_omx` is absent even on a distribution build). The contrast with the bundled binary is policy, not
accident: a distribution ffmpeg links libva, libdrm, and the VPL dispatcher dynamically, and a fully static
single-file build cannot.

Because `src/configuration.ts:136` prefers a configured `ffmpegPath` and falls back to the bundle, both of
these binaries are reachable on the same host depending on configuration, and the plugin currently records
nothing about which one it got.

## 4. Runtime failure modes

Enumeration is not availability. `ffmpeg -encoders` lists every encoder compiled in; whether it opens is
determined at `avcodec_open2` time by a device, a driver, a permission, and a pixel format.

This-host demonstration. Every hardware H.264 encoder listed above enumerates on this host, and every one
fails, each for a different reason:

| Encoder                 | Failure on this host                                        |
| ----------------------- | ----------------------------------------------------------- |
| `h264_vaapi` (system)   | `No VA display found for device /dev/dri/renderD128.`       |
| `h264_qsv` (system)     | `Error creating a MFX session: -9.`                         |
| `h264_nvenc` (system)   | `Cannot load libcuda.so.1`                                  |
| `h264_v4l2m2m` (system) | `Could not find a valid device` / `can't configure encoder` |
| `h264_amf` (bundled)    | `DLL libamfrt64.so.1 failed to open`                        |

Four distinct classes are visible here and all four are documented:

- **Missing device node.** FFmpeg's own documentation for `-init_hw_device vaapi` states that when no device
  is given "it will attempt to open the default X11 display (`$DISPLAY`) and then the first DRM render node
  (`/dev/dri/renderD128`)" (`-init_hw_device` in <https://ffmpeg.org/ffmpeg.html>). On this host
  `/dev/dri` contains `card0` and `by-path` only — there is no `renderD128`. The kernel documents that the
  render node is created only "If a driver advertises render node support" and that userspace then
  "control[s] access to the render node via basic file-system access-modes"
  (<https://www.kernel.org/doc/html/latest/gpu/drm-uapi.html>, "Render nodes"). A card node without a render
  node is not a substitute for VAAPI's purposes.
- **Missing user-space driver.** VA-API "consists of a main library and driver-specific acceleration
  backends for each supported hardware vendor" (<https://github.com/intel/libva#readme>). The device node
  alone is insufficient; the vendor VA driver must be installed and loadable. `h264_qsv`'s `MFX session`
  failure and `h264_amf`'s `libamfrt64.so.1` failure are the same class: the encoder is compiled in but its
  runtime library is absent. `h264_nvenc`'s `libcuda.so.1` failure is likewise a dlopen failure, not a
  configuration error.
- **Wrong pixel format or filter graph.** Attempting `h264_vaapi` with the plugin's current
  `-pix_fmt yuv420p` plus software `scale`/`pad` chain fails inside the filter graph, before any device
  problem is even reached, with `Impossible to convert between the formats supported by the filter` naming
  the plugin's `pad` filter. `h264_qsv` accepts `nv12` or `qsv` and would reject `yuv420p` the same way.
- **Option-parse failure before device probing.** `h264_v4l2m2m` with `-profile:v main`, and `h264_vaapi`
  or `h264_amf` with `-profile:v baseline`, all fail at
  `Error applying encoder options: Invalid argument`,
  which happens whether or not a device exists. A probe that only checks whether the encoder opens would
  not catch these; a probe must run the exact argument list the session will use.

There is also a class the local evidence cannot show: a mid-session runtime failure. `h264_qsv`'s
`check_enc_param` is explicit that `MFXVideoENCODE_Query` may return a corrected parameter set rather than
an error, and the FFmpeg QSV documentation warns that "depending on your system, a different mode than the
one you specified may be selected by the encoder." Similarly, `h264_vaapi` may open in a rate-control mode
other than the one implied by the arguments (`vaapi_encode.c:1278`). These are silent divergences from the
negotiated contract rather than crashes.

## 5. Container and host reality

What a hardware encoder needs from the host, by deployment shape:

- **systemd service on Debian.** A render node must exist under `/dev/dri` (kernel DRM docs, "Render
  nodes"), the vendor VA/CUDA/AMF user-space library must be installed, and the service user must be able to
  open the node. This-host evidence: `/dev/dri/card0` is `crw-rw---- root video`, the `homebridge` user is
  `uid=101(homebridge) gid=103(homebridge) groups=103(homebridge)` and is **not** in `video` or `render`.
  Under `hb-service` the plugin runs as that user, so even a correctly provisioned GPU would be unreachable
  without a group change. The bundled binary would additionally have to be replaced, since it contains no
  VAAPI encoder at all.
- **Docker.** Device nodes are not present in a container unless passed. Docker documents `--device` as "Add
  a host device to the container" and notes that "By default, the container is able to read, write and mknod
  these devices", with permissions overridable per device
  (<https://docs.docker.com/reference/cli/docker/container/run/#device>). NVIDIA GPUs use a separate path:
  `--gpus` "allows you to access NVIDIA GPU resources. First you need to install the
  nvidia-container-runtime" (same page, `--gpus`). Passing the node is necessary but not sufficient: the
  container image must also contain the vendor user-space driver, and the container user must have access to
  the node's group. The `homebridge/docker-homebridge` README does not document a device-passthrough or
  hardware-transcoding path.
- **Raspberry Pi OS.** `h264_v4l2m2m` needs an encoder `/dev/videoN` node from a V4L2 mem2mem driver. On a
  Pi 4 that hardware exists and is budgeted at 1080p30 encode. On a Pi 5 it does not exist at all — the
  product brief lists a decoder and no encoder — so no `/dev/videoN` encoder node will appear regardless of
  packages, which is consistent with `ffmpeg-for-homebridge`'s own statement that Pi 5 is unsupported.

## What this does not answer

- **Cost.** No measurement of software-encoding CPU cost at the concurrent-session count HomeKit actually
  asks for was taken here, on this host or any other. The only figure available is the qualitative one
  already in issue #1033: two concurrent 1280x720@30 sessions at 299 kbps ran on the reference host at
  `8b4cfb2`. There is no hardware-encoder comparison because no hardware encoder opens on this host.
- **Concurrency limits of any hardware encoder.** HomeKit can ask for several simultaneous sessions, and a
  fixed-function encode block is a shared resource in a way that CPU cores are not. Whether any candidate
  encoder can serve the required session count, and whether a vendor imposes an explicit session cap, was
  not established from a primary source here.
- **Whether any hardware encoder actually produces a conforming stream.** Every fidelity statement above is
  derived from FFmpeg source, FFmpeg or vendor documentation, and local option-parse behaviour. No hardware
  encoder was exercised end-to-end and no coded profile, level, or measured bitrate from a hardware encoder
  was inspected. In particular, whether a driver honours a requested profile and `level_idc` rather than
  quietly widening it is a per-driver property and cannot be established from the wrapper source alone.
- **`h264_rkmpp` in Rockchip forks.** Only upstream FFmpeg was checked. Whatever a downstream fork's
  `h264_rkmpp` encoder does with `-profile:v`, `-level:v`, and rate control is unverified here.
- **`h264_mediacodec`, `h264_mf`, `h264_vulkan`.** These exist in FFmpeg 8.0's encoder list but were outside
  the question's scope and were not evaluated. `h264_vulkan` is present in this host's Debian build.
- **VideoToolbox behaviour on real Apple hardware.** All VideoToolbox statements come from
  `libavcodec/videotoolboxenc.c` and Apple's key documentation. Nothing was run on macOS, so which
  profile/level pairs a given Apple SoC's encoder actually accepts, and whether `constant_bit_rate` is
  supported there, is unverified.
- **Whether the `ffmpeg-for-homebridge` policy is stable.** The QSV and VAAPI blocks are commented out in
  `build-ffmpeg` with a stated reason ("libva is broken in static builds"), not removed. A future release
  could enable them. Any decision that depends on the bundled binary's encoder list should treat that list
  as versioned data, not a constant.
