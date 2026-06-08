# Discord Server Rules

Canonical source channel: `#rules`

Source messages:
- English: [jump](https://discord.com/channels/113786069023064068/750183135882510408/750184455465074768)
- Portuguese: [jump](https://discord.com/channels/113786069023064068/750183135882510408/1032468451027075092)

These are the rules the moderation review automation should treat as authoritative.

## Operational Safety Interpretation

The following interpretation is binding for moderation automation because the
public rules' "Above all else, be kind" norm is too soft to carry urgent safety
cases by itself:

- Credible threats, intimidation, stalking, sexual coercion, robbery threats,
  weaponized threats, or declarations of violent conflict are severe safety
  violations.
- A severe safety witness must create or update an open moderation case before a
  review cursor may advance past it.
- Void may escalate, warn, or queue a moderation note, but it must not silently
  treat severe safety evidence as ordinary room chatter.

## Enforcement Policy

The moderation heartbeat must classify each infringement with exactly one
`infringement:<type>` tag plus either `moderation:instaban`,
`moderation:strike`, or `moderation:case_only`.

Strike counts are per user and per infringement type. A strike expires after the
type-specific window below. If a user reaches three unexpired strikes for the
same infringement type, the third strike is a ban. Instant-ban cases skip the
strike ladder.

| Infringement type | Instant-ban condition | Strike condition | Strike expiry |
| --- | --- | --- | --- |
| `safety_threat` | Credible threat of violence, declaration of violent conflict, robbery threat, or real-world harm. | Ambiguous intimidation or aggressive threat-adjacent post that is not yet credible. | 365 days |
| `weaponized_intimidation` | Weapons invoked as a threat, challenge, coercion, or declaration of conflict. | Weapon talk used to posture at a person without a credible immediate threat. | 365 days |
| `stalking_or_doxxing` | Doxxing, tracking, watching, showing up, or threatening offline contact without consent. | Boundary-pushing surveillance talk or repeated unwanted location/contact probing. | 365 days |
| `sexual_boundary_violation` | Sexual coercion, non-consensual sexual content, sexual threats, or sexualized harassment. | Sexual comments outside consent/channel norms that stop short of coercion or threat. | 365 days |
| `bigotry_identity_attack` | Slurs, dehumanization, identity denial, eliminationist rhetoric, or agreeing with a harmful identity sentiment when challenged. | Identity disrespect, targeted stereotyping, or baiting that does not meet the instant-ban bar. | 180 days |
| `bad_faith_argument` | Deliberate malicious impersonation, fabricated evidence, or harmful ironic sentiment affirmed when challenged. | Hypocritical misrepresentation, sealioning, quote twisting, or rhetorical bad faith after correction. | 90 days |
| `nsfw_channel_violation` | Illegal, non-consensual, exploitative, or shock sexual content. | NSFW material outside `#degeneracy`, or low-effort porn in `#degeneracy` with no expressive point. | 30 days |
| `spam_or_deceptive_promotion` | Scam, malware, phishing, or fraudulent promotion. | Repeated ads, self-promotion with misleading claims, or promotion that ignores moderator correction. | 30 days |
| `moderator_obstruction` | Evading, blocking, ignoring, or instructing others to evade active moderator action during a safety issue. | Ignoring moderator requests, continuing after a moderation stop, or procedural obstruction. | 90 days |
| `empty_words_noise` | Coordinated flooding or harassment through low-content agreement/disagreement. | Repeated empty agreement/disagreement after being asked to use reactions or add a point. | 14 days |
| `values_debate_escalation` | Harassment or coercion after a values discussion has been told to stop. | Continuing a preference/value argument after moderator de-escalation. | 14 days |
| `pg13_language_violation` | Threatening, hateful, or sexual explicit language covered by a stronger instant-ban type. | Excessive strong language in non-18+ spaces without artistic purpose. | 14 days |
| `event_time_coordination` | No instant-ban path unless deception or harassment triggers another type. | Repeated event coordination times not given in GMT after correction. | 14 days |

If more than one type applies, choose the strongest type whose instant-ban or
strike condition is actually supported by the message evidence. Do not multiply
strikes for the same message.

## English

```text
Above all else, be kind! Sometimes people lash out when they are hurt, and that's OK but there's a time and a place for that, and it's called #therapy.

Bigotry will not be tolerated. People must be respectful of each others' identities. You can disagree with an opinion, but disagreeing with someone's very existence is evil and we do not allow it.

All argumentation must be done in good faith. If It is determined that you are hypocritically misrepresenting your own position or someone else's for rhetorical advantage, you will be warned. If you insist on repeating the same mistakes, you will be banned. Irony is fine, of course, but if you express a harmful sentiment ironically but still agree with the sentiment when confronted, you will be banned.

There are better places to find porn. NSFW content will only be tolerated in the #degeneracy channel, and even then only when it has something to say. If it has a message beyond primal gratification, that's art and therefore permissible.

Advertising or spam falls under the good faith argumentation policy. You can talk about things you like, even if you made them, but you aren't allowed to lie about them. The less money you're making off something, the more we will tolerate you promoting it.

Our administrator and moderators do not exercise their power lightly. If you block or ignore them, expect consequences.

Try to avoid empty words. If you're merely expressing agreement or disagreement without having a point to make, just react with an emoji

There is no point in debating values. You cannot convince someone to not want the things they want, so once a discussion has devolved to a simple matter of preference, it's best to let it lie.

Try to avoid strong language where possible. Any non-18-plus server should be treated as PG-13, meaning you can use strong language but only occasionally and only for artistic purpose.

All times shared for event coordination should be given in GMT.
```

## Portuguese

```text
Acima de tudo, seja simpático! Por vezes as pessoas atacam quando estão magoadas, e não é problema, mas há um tempo e um lugar para isso, e chama-se a isso terapia.

O intolerância não será tolerado. As pessoas devem respeitar a identidade uns dos outros. Pode-se discordar de uma opinião, mas discordar da simples existência de alguém é perverso e nós não o permitimos.

Toda a argumentação deve ser feita em boa fé. Se é determinado que está hipocritamente a distorcer a sua própria posição ou a de outro por vantagem retórica, será avisado. Se insistir em repetir os mesmos erros, será banido. A ironia é boa, claro, mas se expressar um sentimento prejudicial de forma irónica, mas mesmo assim concordar com o sentimento quando enfrentado, será banido.

Há lugares melhores para encontrar pornografia. O conteúdo NSFW só será tolerado no canal de degenerescência, e mesmo assim só quando tiver algo a dizer. Se tem uma mensagem para além da gratificação primordial, isso é arte e, portanto, admissível.

A publicidade ou spam insere-se na política de argumentação em boa fé. Pode-se falar sobre coisas que se gosta, mesmo que as tenha feito, mas não é permitido mentir sobre elas. Quanto menos dinheiro se ganha com algo, mais toleraremos que o promova.

O nossos administradores e moderadores não exercem o seu poder facilmente. Se os bloquearem ou ignorarem, esperem consequências.

Tente evitar palavras vazias. Se estiver apenas a expressar concordância ou desacordo sem ter um ponto de vista a apontar, basta reagir com um emoji

Não vale a pena debater valores. Não se pode convencer alguém a não querer as coisas que quer, por isso, uma vez que uma discussão tenha passado para uma simples questão de preferência, é melhor deixá-la ficar.

Tentar evitar linguagem grosseira sempre que possível. Qualquer canal que não seja de 18+ deve ser tratado como PG-13, o que significa que se pode usar linguagem forte, mas apenas ocasionalmente e apenas para fins artísticos.
```
