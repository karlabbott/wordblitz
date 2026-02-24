#!/bin/bash
# Chaos script: Spawns expensive cross-join queries against the wordblitz DB
# This will peg CPU on the DB VM and starve the app of database resources
# Run: ssh azureuser@20.42.41.31 "bash /tmp/chaos.sh"
# Stop: The queries can be found and killed via pg_stat_activity

for i in $(seq 1 100); do
  sudo -u postgres psql -d wordblitz -c \
    "SELECT count(*) FROM words a CROSS JOIN words b CROSS JOIN words c;" &
done

echo "Chaos started: 100 cross-join queries running"
echo "DB CPU should spike within seconds"
