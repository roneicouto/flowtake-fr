# Flowtake — diagnóstico da Fase 1

## Escopo e base examinada

Inspeção estática da versão **v1.7.2**, commit `e275a87f42802fbaa1ce5a7c75fdc89c92fd658e`, na branch `fix/windows-recording-encoder`. O clone está em `D:\projs\openscreen-fr\Flowtake`. A branch parte da tag da versão relatada, e não do HEAD atual de main. Não foram encontrados arquivos AGENTS.md no checkout.

Nenhum código funcional foi alterado. Nenhuma instalação, gravação, atualização de driver ou recuperação de gravação anterior foi executada. A análise termina nesta fase para permitir avaliação antes da instrumentação.

## Resultado principal: origem de 0xb1b4b1ab

O valor corresponde exatamente a **AVERROR_UNKNOWN** do FFmpeg:

```text
AVERROR_UNKNOWN = FFERRTAG('U','N','K','N')
FFERRTAG(a,b,c,d) = -(int)MKTAG(a,b,c,d)
MKTAG('U','N','K','N') = 0x4e4b4e55
-0x4e4b4e55 = -1313558101
Representação em 32 bits no Windows = 0xb1b4b1ab
```

A conta foi verificada em PowerShell. Definição oficial: [libavutil/error.h](https://github.com/FFmpeg/FFmpeg/blob/master/libavutil/error.h). O código de referência do [executável FFmpeg](https://github.com/FFmpeg/FFmpeg/blob/master/fftools/ffmpeg.c) propaga o retorno do processamento e da escrita do trailer até o retorno de main, ressalvados tratamentos especiais de outros códigos.

No Flowtake, o caminho da mensagem é inteiramente rastreável em `src-tauri/src/commands/recording.rs`:

1. `start_recording_impl`, linhas 2399–2436: inicia FFmpeg como processo externo e guarda `std::process::Child`.
2. `stop_recording_impl`, linhas 2788–2796: chama `kill_ffmpeg` e marca necessidade de recuperação se houver erro.
3. `kill_ffmpeg`, linhas 4043–4052: lê `process.try_wait()`, verifica `status.success()` e interpola o próprio `ExitStatus` em `The encoder exited with {status}`.
4. `incomplete_recording_error`, linhas 3803–3810: acrescenta o aviso sobre término incompleto e Retry Save.
5. `recording_save_error`, linhas 2514–2515: acrescenta `Recording save failed while finishing the recording`.
6. `stop_recording_impl`, linha 2843 em diante: propaga o erro antes de empacotar o projeto.

Portanto, a mensagem relata o **status do processo FFmpeg completo**, que reúne captura, filtros, codec e container. O Flowtake não fabrica esse número, não o obtém de uma API Rust de encoder e não informa nessa mensagem o HRESULT original de uma chamada DirectX. A coincidência exata com AVERROR_UNKNOWN identifica o código FFmpeg; não identifica sozinha a operação que o produziu na máquina do usuário.

**Causa raiz operacional ainda não confirmada.** O erro pode ter ocorrido durante a gravação e apenas ter sido percebido ao pressionar Stop. A verificação de inicialização observa o processo por somente 200 ms (`verify_capture_process_start`, linha 301). O texto “finishing” identifica o momento de consulta do status, não necessariamente o momento da falha.

## Estrutura e tecnologias efetivas

- `app/`: interface React/JavaScript JSX, estado do editor, timeline, cena PixiJS, workers de prévia/exportação e ponte IPC. A ponte conserva nomes `electron`, mas o backend desta versão é Tauri 2.
- `src-tauri/src/`: backend Rust, comandos, estado da gravação, rastreamento de mouse/teclado e controle dos processos. `src-tauri/native/` contém o helper nativo macOS, fora do caminho Windows analisado.
- `src-tauri/Cargo.toml` e `Cargo.lock`: dependências Rust. No Windows, não há implementação própria de Desktop Duplication nem encoder Media Foundation ligado ao Rust neste caminho. A captura DXGI e o H.264 são delegados ao executável FFmpeg.
- `scripts/`, `test/`, `tests/`: ferramentas de diagnóstico, verificações Node e regressões; testes Rust estão também dentro de `recording.rs` e outros módulos.
- `.github/`, `packaging/`, `resources/`: CI, distribuição e recursos; `docs/` contém documentação; `mcp/` contém a interface MCP do projeto; `website/` é o site separado.

## Fluxo real de gravação de monitor/região no Windows

```text
UI de seleção de monitor/região
  app/windows/areaPicker/App.jsx; app/windows/main/components/properties/AreaSelectorModal.jsx
       ↓ IPC
init_recording_impl / load_recording_preferences
  recording.rs; encoding.rs
  resolve capturador, encoder, FPS, qualidade e coordenadas
       ↓ grava argumentos no estado
start_recording_impl → processo externo FFmpeg
       ↓
lavfi ddagrab → Desktop Duplication / D3D11
  output_idx; draw_mouse=0; região em offset_x/offset_y/video_size
       ↓ transferência conforme encoder
  AMF/NVENC: superfícies D3D11 diretamente, sem -vf de transferência
  QSV: hwmap=derive_device=qsv:mode=read+write+direct
  libx264: hwdownload,format=bgra → conversão negociada para yuv420p
       ↓
H.264 escolhido por encoding.rs
       ↓
Muxer MP4: +frag_keyframe+empty_moov; fragmentos de 1 segundo
       ↓ Stop
kill_ffmpeg → escreve q\n em stdin, flush e fecha o handle
  aguarda saída, com orçamento de 30 segundos
       ↓ somente se bem-sucedido
probe de vídeo → staging de assets → project.json → arquivo ZIP
  gravação screen.mp4 + eventos do cursor/teclado + configuração do projeto
```

As opções de saída são montadas por `recording_video_output_args` (linha 725), `append_recording_output_args` (linha 832) e `ddagrab_transfer_filter` (linha 911). Os comandos de monitor são montados nas linhas 1664–1703; os de região, nas linhas 1529–1575. GDI é uma alternativa selecionável; não é o caminho DXGI do relato.

**Cursor e composição não são incorporados à captura DXGI nesse estágio.** `draw_mouse=0` desativa o cursor na imagem; `mouse_tracker.rs` registra os eventos separadamente. Cena, cursor editável, zoom e efeitos são compostos posteriormente pelo editor em `app/shared/scene/`, incluindo `Scene.js`, `Screen.js`, `PreviewScene.js`, `RenderScene.js`, `zoom/` e os módulos do cursor.

## Seleção de encoder: diferença decisiva em relação aos testes isolados

`encoding.rs::probe_encoder_uncached` (linha 67) codifica **um frame sintético de 128 × 128 para saída null**. A ordem automática Windows é NVENC, QSV, AMF, libx264. Só o log/configuração efetivos podem confirmar qual foi escolhido na gravação que falhou; a presença da RX 6600 não basta para afirmar isso.

Esse probe não valida entrada D3D11 da captura, conversão de cor, 1080p, gravação prolongada, MP4 ou o encerramento por stdin.

Os testes fornecidos comprovam caminhos úteis, mas distintos:

- `testsrc2 → libx264`: entrada sintética em memória de sistema.
- `testsrc2 → h264_amf`: AMF com entrada sintética, sem superfícies provenientes de ddagrab.
- `ddagrab → hwdownload → BGRA → yuv420p → libx264`: captura e download da GPU, sem entrega direta D3D11 ao AMF.

Se AMF foi selecionado, **ddagrab → D3D11 → AMF** é a combinação relevante ainda não coberta pelos resultados apresentados. O teste DXGI fornecido também explicita o dispositivo D3D11; o comando de captura do Flowtake deixa essa criação para ddagrab. Isso é uma diferença a medir, não prova de seleção errada de GPU.

## O que falta para determinar a chamada exata

Na referência atual do [wrapper AMF do FFmpeg](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/amfenc.c), há múltiplas operações que retornam AVERROR_UNKNOWN, entre elas submissão de entrada, drain e validação da fila de timestamps. Exemplos de diagnósticos são `SubmitInput() failed`, `Drain() failed`, `Repeated Drain() failed` e `timestamp_list is empty`. Portanto, nem mesmo confirmar AMF tornaria o número suficiente para distinguir essas causas.

Essa consulta upstream serve para interpretar o código e localizar candidatos. **Não foi inspecionado o fonte exato da build Gyan usada na falha**, nem foi obtido seu stderr. Não atribuo o erro a nenhuma dessas chamadas sem a linha de diagnóstico correspondente.

O Flowtake já drena stderr continuamente (`spawn_ffmpeg_stderr_reader`, linha 261), em chunks limitados e separando CR/LF; não há evidência estática para afirmar um deadlock por ausência de leitura de stderr. Porém:

- `handle_ffmpeg_diagnostic`, linha 242, registra as mensagens em `debug`.
- `lib.rs`, linha 149, configura nível padrão `info`.
- O leitor não conserva uma cauda de diagnóstico vinculada ao resultado de finalização.
- O erro apresentado ao usuário inclui somente o status, sem a operação ou contexto que precedeu a saída.
- A detecção de erros por texto cobre poucos padrões e não constitui monitoramento completo da saúde do processo.

O executável encontrado também precisa ser identificado: `resolve_ffmpeg_path` procura candidatos junto ao aplicativo antes do PATH e usa cache. O FFmpeg testado no terminal não prova qual binário uma instalação anterior executou.

## Encerramento e recuperação

Monitor/região: FFmpeg recebe `q\n`; stdout é descartado e stderr tem leitor dedicado. O orçamento de 30 segundos tem mensagem própria de timeout, diferente do erro com status 0xb1b4b1ab. Não há evidência para simplesmente aumentar esse timeout ou ignorar o status de erro.

Janela: é outro caminho, com `PrintWindow`/BitBlt/GetDIBits → BGRA em memória → stdin do FFmpeg (`capture_window_frame`, linha 977; `window_capture_loop`, linha 1053). Ao parar, sinaliza a thread, espera sua saída e o fechamento de stdin produz EOF. Não envia `q` pelo pipe de pixels.

Falha de finalização: mantém os identificadores e os fragmentos; marca `recording_needs_recovery`; retorna antes de publicar o ZIP. No Retry explícito, `recover_recording_video` (linha 3897) faz remux com descarte de pacotes corrompidos e cópia de streams; valida metadados e decodificação integral, e mantém backup do original antes de substituir o arquivo. Recuperação não recria frames que nunca foram capturados/codificados.

## Tela azul/vazia: investigação separada

A prévia Windows do editor lê o vídeo por elemento de vídeo, cria `VideoFrame` em `PreviewWorkerManager.js::setupVideoFrameCallbacks`, transfere ao worker de prévia e compõe a cena PixiJS/WebGL. `pixiAppOptions.js` usa fundo preto; isso não explica por si só um quadro azul.

A exportação editada usa outra cadeia: Mediabunny em `InputReader.js`/`WorkerInputReader.js` para ler/decodificar, PixiJS no render worker para compor, Mediabunny em `WorkerOutputWriter.js`/`OutputWriter.js` para vídeo/container; `exporter.rs` executa FFmpeg para processamento e mux de áudio. Esse fluxo não gera a mensagem examinada de finalização da captura.

Há um defeito estático concreto no **caminho de janela**: o retorno de `capture_window_frame` é ignorado pelo loop; o retorno de `GetDIBits` e o resultado do fallback BitBlt não são validados. O loop pode encaminhar buffer zerado/antigo ou não validado. Isso merece diagnóstico próprio, mas não confirma a causa de uma gravação de monitor/região via DXGI nem explica especificamente a cor azul.

Para localizar a falha visual, é necessário comparar o `screen.mp4` original fora do editor, frames decodificados desse arquivo, prévia do editor e exportação. Decodificar com sucesso não prova conteúdo visual correto. Sem arquivo de amostra, não é possível atribuir o problema à captura, stride/cor, decodificação do WebView ou composição. No caminho DXGI do relato, stride e transferência de texturas são tratados pelo FFmpeg, não pelo loop BGRA Rust de janela.

## Próxima fase proposta, sem alterações nesta fase

1. Registrar binário/versão efetivos, backend, encoder e argumentos, sanitizando caminhos; reter stderr limitado por sessão e associá-lo à saída do processo.
2. Registrar momento de saída e se precedeu Stop; relacionar contagem de frames/progresso e resultado de finalização. Não registrar imagens por frame.
3. Comparar no mesmo binário: comando real do Flowtake, entrada D3D11 direta no AMF, download/conversão para AMF e caminho libx264. Exercitar tanto limite por duração quanto parada por stdin, em 5 e 60 segundos, com MP4 fragmentado igual ao aplicativo.
4. Só então escolher a menor correção que corresponda à operação que falhou. Não substituir encoder, alterar driver ou modificar a recuperação com base apenas no código genérico.
5. Investigar a tela vazia comparando as quatro etapas visuais acima; se ocorrer em captura de janela, instrumentar os retornos Win32 ignorados.

## Validação e limites

Executados: clone, checkout da tag em branch separada, leitura dos módulos e manifestos, rastreamento da mensagem, consulta ao código primário FFmpeg e verificação aritmética do código de erro.

Não executados: build, testes de captura, testes de codecs, reprodução visual e regressões. `Get-Command` nesta sessão encontrou Node, mas não encontrou `ffmpeg`, `ffprobe` ou `cargo` no PATH; isso não demonstra ausência de instalações fora do PATH. O Flowtake está desinstalado conforme informado. Não houve reinstalação nem busca em dados privados de gravações anteriores.

Conclusão da Fase 1: origem da mensagem e identidade do código confirmadas; chamada interna e causa raiz na máquina ainda pendentes de stderr e reprodução do pipeline real. O principal candidato a testar é a integração D3D11→AMF, condicionado à confirmação do encoder selecionado. O problema visual permanece separado.
