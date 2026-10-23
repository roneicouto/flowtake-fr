# Flowtake — reprodução e correção do caminho DXGI/AMF

## Resultado

Foi reproduzido **0xb1b4b1ab** usando o FFmpeg 9.0.2 Gyan instalado nesta máquina, com os parâmetros de monitor, FPS, bitrate e fragmentação do Flowtake v1.7.2. Não foi necessário reinstalar o Flowtake, FFmpeg ou driver.

O stderr mostrou a operação exata:

```text
AMF initialisation succeeded via D3D11.
[h264_amf] SubmitInput() failed with error 18
Error submitting video frame to the encoder
Task finished with error code: -1313558101 (Unknown error occurred)
Exiting with exit code -1313558101
```

Na enumeração oficial [AMF_RESULT da AMD](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/blob/master/amf/public/include/core/Result.h), **18 é AMF_DIRECTX_FAILED**. O wrapper FFmpeg converte essa falha de submissão em AVERROR_UNKNOWN, que o Windows apresenta como 0xb1b4b1ab.

O processo falhou antes do envio de Stop. Portanto, na reprodução, não foi um timeout de finalização nem falha de drain/ZIP: a inicialização AMF passou, mas a entrega de superfícies D3D11 provenientes de ddagrab falhou. O arquivo tinha cabeçalho MP4 e nenhum pacote de vídeo muxado. O ffprobe ainda retornou zero, mostrando por que apenas detectar um stream declarado é insuficiente.

Isso identifica a falha reproduzida do pipeline real de captura/codificação. Não recupera o stderr histórico da instalação desinstalada; a equivalência com a ocorrência histórica deve ser confirmada na build corrigida. Não se determinou a chamada DirectX interna ao runtime AMD que produziu AMF_DIRECTX_FAILED.

## Correção aplicada

Em `src-tauri/src/commands/recording.rs::ddagrab_transfer_filter`, o caminho AMF passa a usar:

```text
ddagrab → hwdownload → BGRA → NV12 → h264_amf → MP4 fragmentado
```

Filtro: `hwdownload,format=bgra,format=nv12`.

O encoder continua sendo AMF na GPU. A mudança é a transferência/conversão da entrada que evitou a falha em testes reais. Há custo adicional de transferência GPU/CPU e conversão de cor; medições de desempenho em resoluções superiores continuam pendentes. Os caminhos NVENC, QSV e libx264 mantêm suas opções anteriores. Não há alteração no código de cursor, zoom, timeline, seleção de região ou recuperação.

Também foi adicionado `recording_diagnostics.rs`: buffer por processo de até 64 linhas, cada uma limitada a 1.024 caracteres, sem guardar progresso contínuo ou imagens. Redige caminhos absolutos presentes nos argumentos e o diretório pessoal. Aguarda até 500 ms pelo fim do leitor de stderr, sem segurar o mutex de AppState, e seleciona até oito linhas relevantes para o erro. A inicialização e o encerramento passam a incluir esses detalhes nos erros propagados.

Arquivos funcionais alterados: `commands/recording.rs`, `state.rs`, `lib.rs`; novo módulo `recording_diagnostics.rs`. Acrescentados script de reprodução e testes Node; atualizado o teste Rust de transferência conforme encoder.

## Testes reais concluídos

Foram executados **12 casos**: três caminhos, duas durações (5 e 60 segundos) e dois mecanismos de parada (limite por `-t` ou comando `q` por stdin). Todos sem áudio, em monitor 0, 1920×1080 a 30 FPS, com MP4 fragmentado igual ao aplicativo.

- D3D11 direto → AMF: os quatro controles reproduziram 0xb1b4b1ab, antes do envio de Stop, sem vídeo decodificável.
- Download + NV12 → AMF: os quatro casos concluíram com saída zero e decodificação integral bem-sucedida.
- Download → libx264: os quatro casos concluíram com saída zero e decodificação integral bem-sucedida.

Para AMF corrigido: 150 frames / 5,000 s e 1.800 frames / 60,000 s com limite de duração. Com Stop por stdin: 155 frames / 5,166667 s e 1.812 frames / 60,400000 s. A duração por stdin é aproximada e inclui o comportamento de aquisição/filas/encerramento; não corresponde a um corte exato por timestamp.

Nos oito arquivos válidos, ffprobe confirmou H.264, 1920×1080 e 30/1 FPS. A contagem de pacotes correspondeu à contagem de frames decodificados, com DTS estritamente crescentes. Todos passaram por decodificação completa com `-xerror -err_detect explode`. Isso comprova integridade de decodificação, não qualidade visual ou conteúdo correto da tela.

Dados locais, ignorados pelo Git:

- `outputs/recording-diagnostics/2026-10-23T13-21-29-794Z/`: casos de 5 segundos.
- `outputs/recording-diagnostics/2026-10-23T13-22-39-662Z/`: casos de 60 segundos.

Cada diretório contém vídeos, stderr, probes, `results.json` e `timestamp-validation.json`. O script retorna 1 quando algum caso falha; nesta matriz isso ocorre intencionalmente por causa dos controles AMF diretos.

## Testes automatizados e limitações

**24 testes Node passaram**, incluindo o runner de diagnóstico, tratamento de processo travado, envio de Stop, validação que rejeita MP4 sem frames e as suítes existentes de diagnóstico, prévia e DeviceRecorder. `git diff --check` passou.

Uma tentativa adicional de executar `cursor-motion.test.mjs` não iniciou por ausência da dependência `d3-ease`; o teste não foi reportado como aprovado. As dependências npm completas ainda não foram instaladas.

Não há Rust/cargo disponível nesta sessão. Foram encontrados os componentes C++ do Visual Studio 2022 Community. A alteração Rust e seus testes **não foram compilados/executados**, e não foi gerado instalador. A suíte Node não substitui compilação do backend.

Pendentes no aplicativo completo: monitor e região via UI, microfone, áudio do sistema, Retry Save, interrupção inesperada, cursor editável, zoom, timeline e comparação visual entre arquivo original, prévia e exportação. O problema de tela azul/vazia não é declarado resolvido. Não houve alteração do caminho PrintWindow investigado na Fase 1.

## Repetir os testes

Execute na raiz deste clone. O comando captura a tela e mantém os vídeos localmente:

```powershell
node scripts/windows-recording-matrix.mjs --ffmpeg "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffmpeg.exe" --ffprobe "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffprobe.exe" --seconds 5
# Para a segunda duração, substitua 5 por 60.

node --test tests/windows-recording-matrix.test.mjs tests/recording-diagnostics.test.mjs tests/recording-preview-regression.test.mjs tests/device-recorder.test.mjs
```

## Compilação pendente

Depois de disponibilizar Rust estável com target MSVC, usando as ferramentas C++ já instaladas:

```powershell
npm ci
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run lint
npm test
npm run dev
# Após validar o aplicativo:
npm run build
```

Os bundles Windows normalmente serão gerados em `src-tauri/target/release/bundle/`; nenhum bundle está disponível ainda. Instalar Rust no perfil do Windows requer autorização adicional porque a tarefa proíbe alterações fora do projeto.
