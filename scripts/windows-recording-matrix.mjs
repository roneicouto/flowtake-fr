import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function captureArgs(variant, mode, seconds, output) {
    const args = ['-hide_banner', '-loglevel', 'verbose', '-n', '-f', 'lavfi', '-i',
        'ddagrab=output_idx=0:framerate=30:draw_mouse=0:video_size=1920x1080']
    if (variant !== 'amf-direct') args.push('-vf', variant === 'amf-download'
        ? 'hwdownload,format=bgra,format=nv12' : 'hwdownload,format=bgra')
    args.push('-map', '0:v:0', '-c:v', variant === 'x264-download' ? 'libx264' : 'h264_amf')
    if (variant === 'x264-download') args.push('-crf', '24', '-preset', 'superfast', '-pix_fmt', 'yuv420p')
    else args.push('-b:v', '9000k', '-maxrate', '11250k', '-bufsize', '18000k')
    args.push('-r', '30', '-an', '-movflags', '+frag_keyframe+empty_moov', '-frag_duration', '1000000')
    if (mode === 'duration') args.push('-t', String(seconds))
    return [...args, output]
}

export function runProcess(binary, args, { stopAfterMs, timeoutMs = 45000 } = {}) {
    return new Promise(resolve => {
        const started = Date.now()
        const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = '', stderr = '', timedOut = false, sentStop = false
        child.stdout.on('data', data => { stdout = (stdout + data).slice(-2_000_000) })
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-2_000_000) })
        child.stdin.on('error', () => {})
        const stop = stopAfterMs === undefined ? null : setTimeout(() => {
            sentStop = true
            child.stdin.end('q\n')
        }, stopAfterMs)
        const timeout = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
        child.on('error', error => { stderr += `\n${error.message}` })
        child.on('close', (code, signal) => {
            clearTimeout(timeout)
            if (stop) clearTimeout(stop)
            resolve({ code, hex: code === null ? null : `0x${(code >>> 0).toString(16)}`,
                signal, timedOut, sentStop, elapsedMs: Date.now() - started, stdout, stderr })
        })
    })
}

export function validateProbe(probe) {
    const video = probe.streams?.find(stream => stream.codec_type === 'video')
    return Boolean(video && video.codec_name === 'h264' && video.width === 1920 && video.height === 1080
        && video.avg_frame_rate === '30/1' && Number(video.nb_read_frames) > 0 && Number(video.duration) > 0)
}

async function main() {
    const argv = process.argv.slice(2)
    const value = flag => argv[argv.indexOf(flag) + 1]
    if (!argv.includes('--ffmpeg') || !argv.includes('--ffprobe')) {
        throw new Error('Use --ffmpeg <exe> --ffprobe <exe> [--seconds 5|60]. Captures monitor 0 at 1920x1080; saves local videos and logs.')
    }
    const seconds = argv.includes('--seconds') ? Number(value('--seconds')) : 5
    if (![5, 60].includes(seconds)) throw new Error('--seconds must be 5 or 60')
    const ffmpeg = path.resolve(value('--ffmpeg')), ffprobe = path.resolve(value('--ffprobe'))
    const root = path.resolve(fileURLToPath(new URL('../outputs/recording-diagnostics/', import.meta.url)),
        new Date().toISOString().replaceAll(/[:.]/g, '-'))
    await mkdir(root, { recursive: true })
    const version = await runProcess(ffmpeg, ['-version'])
    await writeFile(path.join(root, 'ffmpeg-version.txt'), version.stdout + version.stderr)
    const results = []
    for (const variant of ['amf-direct', 'amf-download', 'x264-download']) {
        for (const mode of ['duration', 'stdin']) {
            const name = `${variant}-${mode}-${seconds}s`
            const output = path.join(root, `${name}.mp4`)
            const args = captureArgs(variant, mode, seconds, output)
            const result = await runProcess(ffmpeg, args, {
                stopAfterMs: mode === 'stdin' ? seconds * 1000 : undefined,
                timeoutMs: (seconds + 35) * 1000,
            })
            await writeFile(path.join(root, `${name}.stderr.log`), result.stderr)
            const probe = await runProcess(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', output])
            const decode = await runProcess(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', output, '-map', '0:v:0', '-f', 'null', '-'])
            await writeFile(path.join(root, `${name}.probe.json`), probe.stdout)
            await writeFile(path.join(root, `${name}.decode.log`), decode.stderr)
            let validVideo = false
            try { validVideo = validateProbe(JSON.parse(probe.stdout)) } catch { /* Invalid probe is a failed test. */ }
            const { stderr: _stderr, stdout: _stdout, ...status } = result
            results.push({ name, args, ...status, probeCode: probe.code, decodeCode: decode.code,
                decodeTimedOut: decode.timedOut, validVideo })
            await writeFile(path.join(root, 'results.json'), JSON.stringify({ ffmpeg, seconds, results }, null, 2))
            console.log(`${name}: exit=${result.hex}, stopSent=${result.sentStop}, probe=${probe.code}, decode=${decode.code}`)
        }
    }
    console.log(`Results: ${root}`)
    if (results.some(result => result.code !== 0 || result.probeCode !== 0 || result.decodeCode !== 0 || !result.validVideo)) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
