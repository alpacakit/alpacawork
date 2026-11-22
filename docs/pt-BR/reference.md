# Termos e comandos

Uma página para consultar o significado dos termos que você vê na tela. Você pode perguntar à IA, no campo de mensagem, o que significa cada item das configurações.

## Nomes dos papéis

| Termo | Significado |
| --- | --- |
| Você | A pessoa que usa a tela |
| Coordenador | A IA que é seu ponto de contato. Tudo o que você envia pelo campo de mensagem chega a ela |
| Responsável | A IA que cuida de uma tarefa |
| Membro | Uma IA que o responsável chama para ajudar |
| Tarefa pai, subtarefa | A tarefa um nível acima e as tarefas abaixo, criadas ao dividir o trabalho |

## Status das tarefas

| Termo | Significado |
| --- | --- |
| Em andamento | A IA está trabalhando |
| Aguardando revisão | É a sua vez. Chegou uma pergunta ou um relatório. Também aparece como status de uma tarefa esperando a revisão de um relatório |
| Requer atenção | É a sua vez. A execução da IA parou |
| Aguardando | Está esperando outra resposta. Não é a sua vez |
| Não iniciadas | Ainda não começaram |
| Adiadas | O que você deixou para depois |
| Concluídas | O que terminou. As tarefas paradas também ficam aqui |
| Erro | Parou. Na lista, fica em “Requer atenção” |

## Motivos de parada

Aparecem na linha em “Requer atenção”. O que fazer está em [Solução de problemas](troubleshooting.md#uma-tarefa-parou).

| Termo | Significado |
| --- | --- |
| Falhou | A execução falhou ou terminou sem relatório |
| Limite atingido | A troca automática entre as IAs chegou ao número máximo de vezes |
| Recebimento não confirmado | Não foi possível confirmar se chegou à IA. Veja o andamento no “Histórico” |
| Recusada | A solicitação seguinte não foi aceita |
| Sem perfil de inicialização | Esse agente de IA não está nas configurações ou não está ativado |
| Não pode iniciar | Não foi possível iniciar a IA responsável |
| Não pode continuar | Não é possível continuar a conversa anterior. Dê a instrução “Continue em uma nova conversa” |
| Limite de profundidade, Limite de solicitações | Chegou ao limite de níveis de subtarefas ou ao número de solicitações de uma execução |
| Tempo esgotado | Passou do tempo máximo de uma execução |
| Encerrou cedo, Não iniciou | O programa do agente de IA parou ou não conseguiu iniciar |

## Teclado

“⌘/Ctrl” é ⌘ no Mac e Ctrl nos outros.

| Tecla | Função |
| --- | --- |
| `/` | Ir para o campo de mensagem |
| ⌘/Ctrl+Enter | Enviar em qualquer dispositivo (no PC, só Enter também envia) |
| `#` no campo de mensagem | Escolher e anexar uma tarefa ou um projeto |
| ⌘/Ctrl+K | Buscar |
| ⌘/Ctrl+, | Abrir as configurações |
| Esc | Sair do campo de mensagem, fechar a tarefa aberta |
| H | Adiar a tarefa aberta |

## Comandos

Execute no terminal (no Windows, dentro do Ubuntu). Os outros comandos são para uso da IA.

| Comando | Função |
| --- | --- |
| `alpacawork setup` | Instalar |
| `alpacawork setup --yes --port <número>` | Mudar a porta da URL da tela |
| `alpacawork setup --yes --public-host <nome>` | Definir o nome `https://` para abrir em outros dispositivos |
| `alpacawork open` | Abrir a tela no navegador |
| `alpacawork start`, `stop`, `restart` | Iniciar, parar, reiniciar |
| `alpacawork status` | Mostrar se está rodando e a URL da tela |
| `alpacawork workspace url` | Mostrar a URL da tela |
| `alpacawork deploy npm:alpacawork` | Atualizar para a versão mais recente |
| `alpacawork uninstall` | Remover deste PC. A pasta de dados fica |
| `alpacawork --version` | Mostrar a versão instalada |
| `alpacawork telemetry off` | Parar o envio dos dados de uso |
