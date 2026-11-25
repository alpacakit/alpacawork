# Abrir de novo, parar e atualizar

## Abrir a tela de novo

A URL da tela (no formato `http://127.0.0.1:43127/`) não muda, mesmo que você feche o navegador ou reinicie o PC. Salve-a nos favoritos ou instale-a como app: no Chrome ou no Edge, pelo “Instalar” em “Configurações (engrenagem) → App e celular”; no Safari do Mac, por “Arquivo → Adicionar ao Dock” no menu (macOS Sonoma ou posterior).

Se esqueceu a URL, execute `alpacawork open` no terminal, e a tela abre no navegador. Onde não é possível abrir um navegador, como em um PC acessado por SSH, aparecem a URL e o jeito de abri-la.

## No Windows

Instale o alpacawork, o Node.js e os agentes de IA dentro do Ubuntu no WSL2. Cole o texto de instalação também na IA dentro do Ubuntu. Se você não tem o WSL2, cole o mesmo texto na IA do Windows, e ela orienta a preparação.

A tela abre no navegador do Windows. O alpacawork só roda enquanto o Ubuntu está rodando. Se você fechar todas as janelas do Ubuntu, ele pode parar; por isso, deixe uma aberta enquanto usa. Depois de reiniciar o Windows, abra o Ubuntu pelo menu Iniciar, e o alpacawork inicia junto.

Se aparecer uma mensagem dizendo que o systemd está desativado, ative-o nesta ordem.

1. No Ubuntu, acrescente estas duas linhas a `/etc/wsl.conf` (é preciso `sudo`).

   ```ini
   [boot]
   systemd=true
   ```

2. No PowerShell, execute `wsl --shutdown` e abra o Ubuntu de novo.

## Se você instalou em um PC acessado por SSH

A URL desse PC não abre no navegador da sua máquina. Peça à IA desse PC “Deixe o alpacawork pronto para usar em outros dispositivos” e abra a URL `https://` que ela informar.

## Parar e iniciar

O alpacawork inicia sozinho quando você faz login no PC. Para controlar por conta própria, execute no terminal:

| O que fazer | Comando |
| --- | --- |
| Parar | `alpacawork stop` |
| Iniciar depois de parar | `alpacawork start` |
| Reiniciar | `alpacawork restart` |
| Ver se está rodando | `alpacawork status` |

Parar o servidor não para o trabalho das IAs em atividade. Para parar o trabalho, [pare](guide.md#adiar-e-parar) a tarefa.

## Atualizar

Quando sai uma nova versão, aparece uma marca em Configurações (a engrenagem). Abra as configurações, pressione “Atualizar” e, na tela de confirmação, pressione “Atualizar” de novo. Quando terminar e aparecer “Recarregar”, pressione.

- As IAs em atividade continuam sem parar. Não é possível voltar à versão anterior.
- Nas versões em que aparece “Copiar a instrução de pausa” no lugar de “Atualizar”, a atualização é feita depois que as IAs em atividade param. Envie no campo de mensagem a instrução copiada, atualize quando as IAs pararem e, depois, peça: “Retome o trabalho que estava pausado”.
- Se não avançar, pressione o botão do aviso que aparece no alto das configurações (“Tentar novamente”, “Continuar” e outros). Se mesmo assim não avançar, peça ajuda à IA.

Sem usar a tela, execute `alpacawork deploy npm:alpacawork`. Só `npm install -g alpacawork` não atualiza o alpacawork que está rodando.

## Desinstalar

Peça ao Claude Code ou ao Codex aberto no terminal “Desinstale o alpacawork”, ou execute no terminal os dois comandos abaixo, nesta ordem. Não é possível enquanto uma IA está trabalhando.

```sh
alpacawork uninstall
npm uninstall -g alpacawork
```

Execute o segundo depois que o primeiro terminar. Na ordem inversa, não dá mais para refazer o primeiro.

A pasta de dados (`~/alpacawork`) fica. Se não precisar dela, apague-a você mesmo. Os arquivos de configuração e de chaves de API e as skills que o alpacawork instalou são removidos.

## Onde ficam os dados e o que é enviado para fora

As tarefas, as conversas e os arquivos criados pela IA ficam na pasta de dados do PC (no início, `~/alpacawork`). Podem ficar ali segredos que a IA leu, então não entregue essa pasta a ninguém. Quando os valores de uma tarefa (objetivo, conclusão, notas etc.) são reescritos ou apagados, os valores anteriores também ficam ali, para que se possa ler a tarefa como estava num momento passado. Não escreva senhas nem chaves neles: apagar um valor não remove as versões anteriores.

O conteúdo das tarefas e das conversas não é enviado ao desenvolvedor. O que sai do PC é o seguinte:

- As instruções para a IA e o conteúdo que ela lê: para o provedor da IA que você usa (como quando você usa o Claude Code e outros normalmente)
- A verificação e o download de novas versões: para o npm
- As notificações (número e título da tarefa): passam criptografadas pelo serviço de notificações do navegador
- Os dados de uso: só se você escolher enviar ([Dados de uso](telemetry.md))

Para fazer uma cópia de segurança, pare o alpacawork e copie a pasta inteira com `cp -a ~/alpacawork <destino>`.
