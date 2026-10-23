import assert from 'node:assert/strict'
import test from 'node:test'
import { captureArgs, runProcess, validateProbe } from '../scripts/windows-recording-matrix.mjs'

test('probe with a declared H264 stream and no frames is not a playable capture', () => {
    const video = { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
        avg_frame_rate: '30/1', nb_read_frames: '150', duration: '5.000000' }
    assert.equal(validateProbe({ streams: [video] }), true)
    assert.equal(validateProbe({ streams: [{ ...video, nb_read_frames: undefined, duration: '0.000000' }] }), false)
    assert.equal(validateProbe({ streams: [] }), false)
})

test('matrix preserves AMF codec and fragmented MP4 while isolating the transfer', () => {
    const direct = captureArgs('amf-direct', 'duration', 5, 'capture.mp4')
    const downloaded = captureArgs('amf-download', 'duration', 5, 'capture.mp4')
    assert.equal(direct.includes('-vf'), false)
    assert.equal(downloaded[downloaded.indexOf('-vf') + 1], 'hwdownload,format=bgra,format=nv12')
    for (const args of [direct, downloaded]) {
        assert.equal(args[args.indexOf('-c:v') + 1], 'h264_amf')
        assert.equal(args[args.indexOf('-movflags') + 1], '+frag_keyframe+empty_moov')
        assert.equal(args[args.indexOf('-t') + 1], '5')
    }
    assert.equal(captureArgs('amf-download', 'stdin', 60, 'capture.mp4').includes('-t'), false)
})

test('runner retains operation diagnostics and nonzero exit', async () => {
    const result = await runProcess(process.execPath, ['-e',
        'process.stderr.write("SubmitInput() failed with error 18");process.exitCode=18'])
    assert.equal(result.code, 18)
    assert.equal(result.hex, '0x12')
    assert.match(result.stderr, /SubmitInput/)
    assert.equal(result.sentStop, false)
})

test('runner sends q through stdin and captures drained output', async () => {
    const result = await runProcess(process.execPath, ['-e',
        'process.stdin.on("data", b => {process.stdout.write(b);process.exitCode=0});'],
    { stopAfterMs: 100, timeoutMs: 5000 })
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'q\n')
    assert.equal(result.sentStop, true)
    assert.equal(result.timedOut, false)
})

test('runner bounds a stalled process', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 })
    assert.equal(result.timedOut, true)
    assert.ok(result.elapsedMs < 5000)
})
