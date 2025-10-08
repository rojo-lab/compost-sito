# Usa un'immagine ufficiale di Node.js leggera come base
FROM node:18-alpine

# Imposta la cartella di lavoro all'interno del container
WORKDIR /app

# Copia prima i file di gestione delle dipendenze.
# Questo è un trucco per velocizzare le build future: se non modifichi le dipendenze,
# Docker non le reinstallerà ogni volta.
COPY package*.json ./

# Installa le dipendenze del progetto
RUN npm install

# Copia tutto il resto del progetto (codice, file statici, ecc.) nella cartella di lavoro
COPY . .

# Esponi la porta 3000, quella su cui il nostro server è in ascolto
EXPOSE 3000

# Il comando da eseguire quando il container viene avviato
CMD [ "node", "index.js" ]
