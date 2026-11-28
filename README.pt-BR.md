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
  Faça um pedido. Os agentes de IA do seu PC, como o Claude Code e o Codex, o dividem em tarefas e as rodam em paralelo.<br/>
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

## O que é o alpacawork?

O alpacawork reúne várias IAs para fazer o trabalho avançar. É uma ferramenta de orquestração de IA baseada em tarefas. Você coordena o Claude Code e o Codex que já usa em um único campo de chat.

É só fazer o pedido à IA que atende nesse chat, a coordenadora. Ela acompanha o andamento e repassa instruções às IAs que fazem o trabalho. Assim, você pode delegar tanto a divisão das tarefas quanto as instruções detalhadas.

<p align="center">
  <img src="docs/images/demo-dark-pt-BR.gif" alt="Um diagrama ao lado do aplicativo mostra um pedido virar três propostas que Claude e Codex preparam em paralelo. As mudanças passam pelo mesmo chat. Se uma IA atinge o limite de uso, outra retoma a partir do registro da tarefa. Conversas longas são compactadas ou reiniciadas. Você escolhe uma opção para responder, confere o resultado no celular e desliza para a direita para concluir." width="800">
</p>

### Peça

- Use o mesmo campo de chat para fazer pedidos e mudanças em [vários projetos](docs/pt-BR/projects.md#criar-mais-projetos).
- [Diga como trabalhar](docs/pt-BR/concept.md#diga-como-prosseguir-com-palavras). Exemplo: “Faça três propostas com modelos diferentes”.
- Use o login de sempre, `CLAUDE.md`, as skills e o MCP. [Também funciona com Copilot e pi](docs/pt-BR/projects.md#as-ias-que-você-usa).

### O trabalho avança

- A [tarefa](docs/pt-BR/concept.md#o-trabalho-avança-por-tarefas-não-por-conversas) guarda o histórico e os resultados, mesmo se você trocar de IA ou chat.
- Se um erro ou limite de uso interromper o trabalho, [troque de IA e continue dali](docs/pt-BR/guide.md#tarefas-paradas).
- Conforme a conversa avança, [a precisão cai](https://arxiv.org/abs/2505.06120). A IA decide se compacta a conversa ou abre outra.

### Confira

- Quando precisa de uma decisão sua, a IA [pergunta com opções e uma recomendação](docs/pt-BR/guide.md#responder-a-perguntas).
- Perguntas e [relatórios](docs/pt-BR/guide.md#revisar-relatórios) podem incluir imagens ou vídeos para ajudar você a decidir.
- Peça, responda e confira pelo [celular](docs/pt-BR/remote.md#usar-pelo-celular). [Deslize](docs/pt-BR/guide.md#no-celular) para responder ou concluir.

## Instalar

Cole o texto abaixo no Claude Code ou no Codex do seu PC. A IA instala o alpacawork e informa a URL da tela de configuração inicial, que normalmente também abre no navegador.

```text
Baixe o guia abaixo, leia-o inteiro e siga as instruções para instalar o alpacawork neste PC.
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

Para instalar pela linha de comando, execute estas duas linhas no terminal (no Windows, dentro do Ubuntu), nesta ordem. A configuração inicial mostra o que vai preparar e começa quando você pressiona Enter.

```sh
npm install -g alpacawork
alpacawork setup
```

Os requisitos são macOS (Apple silicon), Linux (x64) ou Windows (WSL2). Depois de instalar, siga os [Primeiros passos](docs/pt-BR/getting-started.md) para fazer a sua primeira solicitação.

### Abrir a tela

Para abrir a tela no navegador, peça assim no Claude Code ou no Codex (`$alpacawork` no Codex).

```text
/alpacawork abra a tela
```

No terminal, `alpacawork open` também abre a tela.

## Vale saber

- **É gratuito (licença MIT).** O uso de IA é cobrado de acordo com o plano que você já tem do Claude Code, do Codex ou de outro agente.
- **Roda no seu PC.** Mantenha o PC ligado e configure-o para não entrar em suspensão enquanto você usa o alpacawork.
- **O alpacawork inicia os agentes de IA no mesmo modo sem confirmações que o `bypassPermissions` do Claude Code e o `danger-full-access` do Codex, então eles não param para perguntar.** Você pode escrever na [política do projeto](docs/pt-BR/projects.md#política-do-projeto) o que a IA não deve fazer, ou o que deve perguntar a você antes.
- **Tarefas, conversas e arquivos de resultado ficam no seu PC.** O alpacawork não os envia a nenhum servidor externo mantido pelos desenvolvedores. Suas instruções para a IA e o conteúdo que ela lê são enviados ao provedor da IA, como acontece quando você usa cada agente de IA diretamente ([mais sobre o tratamento dos dados](docs/pt-BR/manage.md#onde-ficam-os-dados-e-o-que-é-enviado-para-fora)).

## Documentação

- [Primeiros passos](docs/pt-BR/getting-started.md) — instalar, fazer uma solicitação e revisar o resultado
- [Início da documentação](docs/pt-BR/README.md) — como usar, configurações, solução de problemas e a lista de todas as páginas
- Reporte bugs nas [Issues](https://github.com/alpacakit/alpacawork/issues)
- Os anúncios de novas versões são publicados no X: [@codemafia0000](https://x.com/codemafia0000)

## Licença

[Licença MIT](LICENSE)
