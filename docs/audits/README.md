# Audyty

Każda bramka audytowa tworzy niezmienny dokument:

```text
docs/audits/<TASK_ID>/AUDIT-<NN>.md
```

Użyj `docs/templates/AUDIT_TEMPLATE.md`. Sol niezależnie weryfikuje kod wykonany
przez Lunę i nie poprawia implementacji w ramach samego audytu. Findingi są
po audycie zamieniane na małe fix work units.

## Findingi przekrojowe

Finding, który **nie należy do audytowanego taska** — bo dotyczy innego, wcześniej
zaakceptowanego pakietu albo całego repozytorium — trafia do
[`CROSS_TASK_FINDINGS.md`](CROSS_TASK_FINDINGS.md). Audyt taska wspomina go i
linkuje, ale nie blokuje nim werdyktu: task nie odpowiada za defekt poza swoim
zakresem. Rejestr istnieje, bo takie findingi nie mają naturalnego właściciela i
bez niego giną między taskami.
