# ManagerCycling Stats

Web estilo ProCyclingStats con los resultados e inscripciones del foro
[Managercycling](https://managercycling.foroactivo.com).

- **Botón Actualizar**: lee del foro los temas nuevos y recalcula todo al momento.
- **Cada 3 horas** la tarea *Actualizar datos del foro* (pestaña Actions) guarda
  los datos nuevos en `data/`, para que todo el mundo los vea al abrir la web.

Nueva temporada: cambia en `scripts/config.json` el bloque `current`
(año y final de las direcciones de RESULTADOS e INSCRIPCIONES, por ejemplo
`"455-resultados"`) y mueve la temporada anterior a `seasons`.
