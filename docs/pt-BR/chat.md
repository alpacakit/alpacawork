# Usar pelo Claude Code ou Codex

Você também pode operar o alpacawork numa conversa do Claude Code ou do Codex.

## Como começar

Coloque `/alpacawork` na frente só do primeiro pedido da conversa (`$alpacawork` no Codex).

```text
/alpacawork me conte, uma por uma e de forma breve, as tarefas aguardando revisão
```

A partir daí, a IA dessa conversa atua como ponto de contato (o coordenador). Na caixa de entrada da tela do alpacawork, o `/alpacawork` não é necessário.

O trabalho que você pede é feito pelas IAs responsáveis, então fechar a conversa não o interrompe. Perguntas e relatórios chegam em "Aguardando revisão" na tela.

## Exemplos do que pedir sobre as tarefas

| Para | Exemplo do que pedir |
| --- | --- |
| Pedir uma tarefa | `crie uma tarefa para corrigir o bug da tela de login e comece` |
| Ver as tarefas aguardando revisão | `me conte, uma por uma e de forma breve, as tarefas aguardando revisão` |
| Perguntar como vão as tarefas | `me diga como vão as tarefas` |
| Encontrar uma tarefa | `encontre a tarefa que corrigiu o README` |
| Responder uma pergunta | `na pergunta da T12, siga com a opção 2` |
| Pedir um ajuste | `deixe o texto do botão na T12 mais curto` |
| Marcar como concluída | `já conferi a T12. Marque como concluída` |
| Adiar ou parar | `adie a T12`, `pare a T12` |
| Criar um projeto | `transforme ~/code/shop num projeto` |

Você pode indicar uma tarefa pelo número (como T12) ou por palavras do título. Os mesmos pedidos funcionam na caixa de entrada da tela.

## Operar o próprio alpacawork

| Para | Exemplo do que pedir | Comando |
| --- | --- | --- |
| Abrir a tela | `abra a tela` | `alpacawork open` |
| Ver se está rodando | `veja se está rodando` | `alpacawork status` |
| Mudar uma configuração | `rode no máximo 4 IAs ao mesmo tempo` | — |
| Mudar o modelo de uso normal | `use o opus normalmente nas tarefas` | — |
| Disponibilizar um modelo novo | `saiu um modelo novo do Codex; adicione nas configurações de modelos para eu poder escolher` | — |
| Mudar a política do projeto | `acrescente "use o opus para o design" à política do projeto` | — |
| Atualizar para a versão mais recente | `atualize para a versão mais recente` | `alpacawork deploy npm:alpacawork` |
| Parar, iniciar ou reiniciar | `reinicie o alpacawork` | `alpacawork stop`, `start`, `restart` |
| Desinstalar | `desinstale o alpacawork` | `alpacawork uninstall` e depois `npm uninstall -g alpacawork` |

Mudanças de configurações, de modelos e da política do projeto também podem ser pedidas na caixa de entrada da tela. Parar, reiniciar e desinstalar não podem ser feitos pela caixa de entrada da tela. Os outros comandos podem ser vistos com `alpacawork -h` ([Abrir de novo, parar e atualizar](manage.md)).
