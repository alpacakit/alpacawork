<p align="center">
  <a href="README.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <b>Português (Brasil)</b>
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wordmark-dark.png">
    <img src="docs/images/wordmark.png" alt="alpacawork" width="380">
  </picture>
</h1>

<h3 align="center">Deixe a gestão das suas IAs com a IA.</h3>

<p align="center">
  Ela atribui trabalho ao Claude Code e ao Codex<br/>e acompanha o andamento deles.<br/>
  Você não precisa mais ficar na frente do PC para trabalhar.
</p>

<p align="center">
  <a href="#instalar"><b>Instalar</b></a> ·
  <a href="docs/pt-BR/getting-started.md">Primeiros passos</a> ·
  <a href="docs/pt-BR/concept.md">Como funciona</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/alpacawork"><img alt="npm" src="https://img.shields.io/npm/v/alpacawork?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

<!-- The intro video goes here once it is uploaded on github.com: one line holding the URL GitHub gives. Then move the picture below to the end of the features list. -->

<p align="center">
  <img src="docs/images/pc-phone-dark.png" alt="O alpacawork no navegador de um PC, com uma lista de dez tarefas em andamento e três aguardando revisão ao lado do relatório aberto de uma tarefa, e à direita um celular que mostra o mesmo relatório" width="820">
</p>

O alpacawork é uma ferramenta (um harness de IA) que executa os agentes Claude Code e Codex já instalados no seu PC e atribui trabalho a eles. Escreva o que você quer em um único campo de mensagem, e o coordenador, a IA que é seu ponto de contato, transforma isso em tarefas, atribui as tarefas a outras IAs e acompanha o andamento. Você faz três coisas: pede, responde às perguntas e revisa os resultados. Pelo celular, você usa do mesmo jeito.

## Instalar

Cole o texto abaixo no Claude Code ou no Codex do seu PC. A IA instala o alpacawork e informa a URL da tela de configuração inicial, que normalmente também abre no navegador.

```text
Baixe o guia abaixo, leia-o inteiro e siga as instruções para instalar o alpacawork neste PC.
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

Para instalar pela linha de comando, execute estas duas linhas no terminal (no Windows, dentro do Ubuntu), nesta ordem. A configuração inicial mostra o que vai preparar e começa quando você pressiona Enter. Ao terminar, ela mostra a URL da tela na linha `Abra:` (`Open:` se o terminal estiver em inglês) e normalmente a abre no navegador.

```sh
npm install -g alpacawork
alpacawork setup
```

Os requisitos são macOS (Apple silicon), Linux (x64) ou Windows (WSL2). Depois de instalar, siga os [Primeiros passos](docs/pt-BR/getting-started.md) para fazer a sua primeira solicitação.

### Operações comuns

As tarefas são pedidas na caixa de entrada da tela. Para abrir a tela, mudar configurações e coisas assim, peça ao Claude Code ou ao Codex aberto no terminal ou no app, e a IA faz isso (no Codex, escreva `$alpacawork` no lugar de `/alpacawork`). No terminal, os comandos da tabela fazem o mesmo.

| Para | Peça à IA | Comando |
| --- | --- | --- |
| Abrir a tela | `/alpacawork abra a tela` | `alpacawork open` |
| Ver se está rodando | `/alpacawork veja se está rodando` | `alpacawork status` |
| Mudar uma configuração | `/alpacawork rode no máximo 4 IAs ao mesmo tempo` | — |
| Mudar o modelo de uso normal | `/alpacawork use o opus normalmente nas tarefas` | — |
| Disponibilizar um modelo novo | `/alpacawork saiu um modelo novo do Codex; adicione nas configurações de modelos para eu poder escolher` | — |
| Mudar a política do projeto | `/alpacawork acrescente "use o opus para o design" à política do projeto` | — |
| Atualizar para a versão mais recente | `/alpacawork atualize para a versão mais recente` | `alpacawork deploy npm:alpacawork` |
| Parar, iniciar ou reiniciar | `/alpacawork reinicie o alpacawork` | `alpacawork stop`, `start`, `restart` |
| Desinstalar | `/alpacawork desinstale o alpacawork` | `alpacawork uninstall` e depois `npm uninstall -g alpacawork` |

Configurações e modelos também podem ser mudados na caixa de entrada ou em Configurações na tela, e a atualização também pode ser feita em Configurações. Os outros comandos e o uso deles podem ser vistos com `alpacawork -h` (detalhes em [Abrir de novo, parar e atualizar](docs/pt-BR/manage.md)).

Pedir tarefas, procurá-las, responder perguntas e coisas assim também funciona numa conversa do Claude Code ou do Codex. Como pedir está em [Usar pelo Claude Code ou Codex](docs/pt-BR/chat.md).

No Chrome ou no Edge, você pode instalá-la como app no final da configuração inicial na tela, ou depois em Configurações → App e celular, e abri-la de novo pelo ícone no Dock ou na barra de tarefas. No Safari do Mac, instale com Arquivo → Adicionar ao Dock no menu (macOS Sonoma ou posterior).

## O que ele faz

- **Peça tudo em um único campo de mensagem.** O coordenador transforma cada solicitação em uma tarefa e a delega a uma IA. Você não precisa trocar de chat nem de IA a cada trabalho.
- **Uma IA gerencia várias IAs ao mesmo tempo.** Para acrescentar ou mudar algo em um trabalho em andamento, basta dizer ao coordenador. Escreva “Nas três tarefas em andamento, verifique também o layout no celular”, e o coordenador passa essa instrução a cada IA que trabalha nelas.
- **Descreva o processo com suas palavras, e as IAs o executam juntas.** Mesmo um processo mais elaborado, como “Faça três propostas, cada uma com um modelo diferente. Junte as três em uma só, peça para outra IA revisar e corrija antes de relatar”, é executado como você descreveu: a IA gerencia as etapas, e as IAs passam o trabalho umas para as outras.
- **As perguntas da IA vêm com opções e uma recomendação.** Perguntas e relatórios chegam com imagens e vídeos. Para responder, basta escolher uma opção.
- **Uma tela pensada para o celular.** Para responder a uma pergunta ou marcar um resultado como concluído, basta deslizar para a direita. Você pode levar uma tarefa da solicitação à conclusão usando só o celular. A mesma tela também funciona no navegador do PC.
- **Roda no seu ambiente de sempre.** O `AGENTS.md`, o `CLAUDE.md`, as skills, o MCP e os hooks continuam funcionando como estão. Você não precisa de conta nem de chave de API do alpacawork.

## Vale saber

- **É gratuito (licença MIT).** O uso de IA é cobrado de acordo com o plano que você já tem do Claude Code, do Codex ou de outro agente.
- **Roda no seu PC.** A IA roda no PC, então mantenha o PC ligado e configure-o para não entrar em suspensão enquanto você usa o alpacawork.
- **O alpacawork inicia os agentes de IA no mesmo modo sem confirmações que o `bypassPermissions` do Claude Code e o `danger-full-access` do Codex, então eles não param para perguntar.** Você pode escrever na [política do projeto](docs/pt-BR/projects.md#política-do-projeto) o que a IA não deve fazer, ou o que deve perguntar a você antes.
- **Tarefas, conversas e arquivos de resultado ficam no seu PC.** O alpacawork não os envia a nenhum servidor externo mantido pelos desenvolvedores. Suas instruções para a IA e o conteúdo que ela lê são enviados ao provedor da IA, como acontece quando você usa cada agente de IA diretamente ([mais sobre o tratamento dos dados](docs/pt-BR/manage.md#onde-ficam-os-dados-e-o-que-é-enviado-para-fora)).

## Documentação

- [Primeiros passos](docs/pt-BR/getting-started.md) — instalar, fazer uma solicitação e revisar o resultado
- [Início da documentação](docs/pt-BR/README.md) — como usar, configurações, solução de problemas e a lista de todas as páginas
- Reporte bugs nas [Issues](https://github.com/alpacakit/alpacawork/issues)

## Licença

[Licença MIT](LICENSE)
