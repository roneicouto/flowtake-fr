# Fork pessoal: build Windows e atualizações upstream

Repositório: https://github.com/roneicouto/flowtake-fr

Origem: https://github.com/JNX03/Flowtake

O histórico Git original é preservado. No clone local, `origin` aponta para o repositório pessoal e `upstream` para a origem. A versão inicial deste fork parte da tag v1.7.2 e contém a correção reproduzida do caminho DXGI/AMF.

## Compilação e download

O workflow **Windows fork build and release** testa JavaScript, formatação Rust, testes Rust e clippy, compila NSIS/MSI e monta um ZIP portátil. É executado em pushes para main, PRs para main e manualmente pela aba Actions.

Depois de um push para main com todas as etapas aprovadas, publica uma prerelease Windows em:

https://github.com/roneicouto/flowtake-fr/releases

As tags seguem `windows-v1.7.2-build.N.T`, em que N é a execução e T a tentativa. A versão interna do app permanece 1.7.2 nesta correção; cada release identifica o commit exato em COMMIT.txt e inclui SHA256SUMS.txt. O prefixo evita acionar o workflow multiplataforma original de tags `v*`.

Em PRs, a compilação produz somente um artifact de Actions; a publicação fica restrita a main. Uma execução manual em main permite desmarcar `publish` para gerar somente o artifact. Não são necessárias chaves de assinatura para produzir estes instaladores sem assinatura. FFmpeg continua instalado separadamente.

O workflow original `Release` e o CI multiplataforma continuam no histórico e não foram substituídos. O workflow novo fornece um caminho independente para publicar o Windows sem aguardar builds Linux/macOS. Testes em runners GitHub não substituem a validação na GPU física.

## Atualizações do Flowtake original

O workflow **Check upstream updates** consulta a main de JNX03/Flowtake diariamente às 12:17 UTC (09:17 de Fortaleza) ou manualmente na aba Actions. Se houver commits ainda não incorporados, atualiza a branch `sync/upstream-main` por push normal e abre/atualiza um PR para main. Não modifica main e não executa merge automático. Um histórico upstream reescrito ou edição inesperada da branch de sincronização faz o push falhar em vez de sobrescrever commits.

O PR pode apresentar conflitos. Eles precisam ser resolvidos preservando as correções locais antes de incorporar a atualização. Use **Create a merge commit** no GitHub; isso mantém a ancestralidade upstream e permite detectar quais commits já foram incorporados. Cada novo commit na branch de sincronização atualiza o mesmo PR aberto e dispara seus checks usando o token pessoal limitado ao repositório.

## Secret necessário para sincronização

Crie um fine-grained personal access token em https://github.com/settings/personal-access-tokens/new, limitado somente a `roneicouto/flowtake-fr`, com permissões de repositório:

- Contents: Read and write.
- Pull requests: Read and write.
- Workflows: Read and write.

Salve o valor como **UPSTREAM_SYNC_TOKEN** em:

https://github.com/roneicouto/flowtake-fr/settings/secrets/actions

Não publique o token em commits, logs ou chat. Defina expiração e renove o secret quando necessário. O workflow padrão usa somente leitura com GITHUB_TOKEN; o secret é acessado exclusivamente pelo workflow de sincronização na branch main, e não pelos builds de PR. A permissão Workflows é necessária para que atualizações upstream possam incluir arquivos `.github/workflows/`.

O build/publicação de Windows usa o GITHUB_TOKEN nativo e não depende desse secret. A sincronização informará a falta do secret até ele ser configurado.

## Validação local antes do primeiro envio

As dependências npm foram instaladas a partir do lockfile, com cache local em outputs/npm-cache. Na primeira execução completa de testes no Windows, dois testes ZIP do MCP revelaram um defeito preexistente: o caminho temporário abreviado do Windows era comparado a um caminho canônico diferente. A extração agora resolve a saída a partir de realDestination, mantendo as verificações de contenção e symlinks. Há um teste de regressão com junction/alias. Essa correção é separada do problema de captura e é necessária para que os checks Windows completos passem.

Rust não foi instalado nesta máquina. A compilação, formatação e testes do backend serão verificados no runner Windows do GitHub. Nenhuma captura ou vídeo de diagnóstico local é enviado: outputs/ está ignorado pelo Git.
