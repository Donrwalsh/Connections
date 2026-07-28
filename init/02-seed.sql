INSERT INTO Puzzle (date)
VALUES
  ('2023-06-12');

INSERT INTO AnswerGroup (puzzle_id, level, group_name)
VALUES
  (1, 0, 'WET WEATHER'),
  (1, 1, 'NBA TEAMS'),
  (1, 2, 'KEYBOARD KEYS'),
  (1, 3, 'PALINDROMES');

INSERT INTO GroupMember (group_id, word, position)
VALUES
  (1, 'HAIL', 9),
  (1, 'RAIN', 11),
  (1, 'SLEET', 12),
  (1, 'SNOW', 0),
  (2, 'BUCKS', 6),
  (2, 'HEAT', 4),
  (2, 'JAZZ', 8),
  (2, 'NETS', 15),
  (3, 'OPTION', 10),
  (3, 'RETURN', 7),
  (3, 'SHIFT', 2),
  (3, 'TAB', 5),
  (4, 'KAYAK', 3),
  (4, 'LEVEL', 1),
  (4, 'MOM', 14),
  (4, 'RACECAR', 13);