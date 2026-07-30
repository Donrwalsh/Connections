import { Client } from "pg";

async function main() {
  const client = new Client({
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "postgres",
    database: "mydb",
  });

  await client.connect();

  const latestDateResult = await client.query(
    'SELECT MAX(date) AS latest_date FROM "Puzzle";',
  );
  let latestDate = latestDateResult.rows[0].latest_date;

  while (true) {
    const nextDate = new Date(latestDate);
    nextDate.setDate(nextDate.getDate() + 1);

    const formattedDate =
      nextDate.getFullYear() +
      "-" +
      String(nextDate.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(nextDate.getDate()).padStart(2, "0");

    const awkwardDates = [
      "2024-12-12",
      "2025-04-01",
      "2025-10-31",
      "2026-02-07",
      "2026-03-07",
      "2026-04-01",
      "2026-05-06",
    ];

    if (awkwardDates.includes(formattedDate)) {
      latestDate = nextDate;
      console.log(`Skipping ${formattedDate} data because it's awkward`);
      continue;
    }

    const url = `https://www.nytimes.com/svc/connections/v2/${formattedDate}.json`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch puzzle for ${formattedDate}: ${response.status}`,
      );
    }

    const data: ConnectionsPuzzle = await response.json();

    const insertResultFirst = await client.query(
      `INSERT INTO "Puzzle" (date)
       VALUES ($1)
       RETURNING id`,
      [formattedDate],
    );

    const puzzleId = insertResultFirst.rows[0].id;

    var group_level = -1;

    for (const category of data.categories) {
      group_level++;

      const categoryResult = await client.query(
        `INSERT INTO "AnswerGroup" (puzzle_id, level, group_name)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [puzzleId, group_level, category.title],
      );

      const groupId = categoryResult.rows[0].id;

      for (const card of category.cards) {
        await client.query(
          `INSERT INTO "GroupMember" (group_id, word, position)
           VALUES ($1, $2, $3)`,
          [groupId, card.content, card.position],
        );
      }
    }
    console.log(`Successfully added ${formattedDate} data`);

    latestDate = nextDate;
  }

  await client.end();
}

main().catch(console.error);

export interface ConnectionsCard {
  content: string;
  position: number;
}

export interface ConnectionsGroup {
  title: string;
  cards: ConnectionsCard[];
}

export interface ConnectionsPuzzle {
  id: number;
  print_date: string;
  categories: ConnectionsGroup[];
}
