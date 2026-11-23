<p align="center">
  <a href="README.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <b>Português (Brasil)</b>
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wordmark-dark.png">
    <img src="docs/images/wordmark.png" alt="alpacawork" width="380">
  </picture>
</h1>

<h3 align="center">Controle todos os seus agentes de IA em um só chat.</h3>

<p align="center">
  Faça um pedido. O Claude Code e o Codex no seu PC o dividem em tarefas e as rodam em paralelo.<br/>
  Você responde às perguntas da IA e revisa os resultados. Também pelo celular.
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

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark-pt-BR.gif">
    <img src="docs/images/hero-pt-BR.gif" alt="Um pedido escrito em um só campo chega ao coordenador, que cria tarefas em três projetos (site, app, marketing) e atribui a cada uma uma IA como opus · high ou gpt-5 · high; uma tarefa faz uma pergunta, você responde e todas terminam" width="640">
  </picture>
</p>

O alpacawork é uma ferramenta (um harness de IA) que executa os agentes Claude Code e Codex já instalados no seu PC e atribui trabalho a eles. Escreva o que você quer em um único campo de mensagem, e o coordenador, a IA que é seu ponto de contato, transforma isso em tarefas, atribui as tarefas a outras IAs e acompanha o andamento. Você faz três coisas: pede, responde às perguntas e revisa os resultados. Pelo celular, você usa do mesmo jeito.

<p align="center">
  <img src="docs/images/pc-phone-dark.png" alt="O alpacawork no navegador de um PC, com uma lista de dez tarefas em andamento e três aguardando revisão ao lado do relatório aberto de uma tarefa, e à direita um celular que mostra o mesmo relatório" width="820">
</p>

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

### Abrir a tela de novo

Para abrir a tela no navegador, peça assim no Claude Code ou no Codex (`$alpacawork` no Codex).

```text
/alpacawork abra a tela
```

No terminal, `alpacawork open` também abre a tela.

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
