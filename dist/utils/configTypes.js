export var SnapshotHandlingMethod;
(function (SnapshotHandlingMethod) {
    SnapshotHandlingMethod[SnapshotHandlingMethod["Auto"] = 0] = "Auto";
    SnapshotHandlingMethod[SnapshotHandlingMethod["AlwaysFresh"] = 1] = "AlwaysFresh";
    SnapshotHandlingMethod[SnapshotHandlingMethod["Balanced"] = 2] = "Balanced";
    SnapshotHandlingMethod[SnapshotHandlingMethod["CloudOnly"] = 3] = "CloudOnly";
})(SnapshotHandlingMethod || (SnapshotHandlingMethod = {}));
export const DEFAULT_CAMERACONFIG_VALUES = {
    name: '',
    manufacturer: '',
    model: '',
    serialNumber: '',
    firmwareRevision: '',
    enableButton: true,
    motionButton: true,
    lightButton: true,
    audio: true,
    talkback: false,
    talkbackChannels: 1,
    hsvRecordingDuration: 90,
    rtsp: false,
    enableCamera: true,
    snapshotHandlingMethod: SnapshotHandlingMethod.CloudOnly,
    delayCameraSnapshot: false,
    indoorChimeButton: false,
};
export const DEFAULT_VIDEOCONFIG_VALUES = {
    probeSize: 16384,
    vcodec: 'copy',
    acodec: 'copy',
};
