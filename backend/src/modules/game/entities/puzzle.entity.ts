import "reflect-metadata";
import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm";
import { AnswerGroup } from "./answer-group.entity";

@Entity("Puzzle")
export class Puzzle {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "date" })
  date: string;

  @Column({ type: "boolean", default: false })
  is_image_puzzle: boolean;

  @OneToMany(() => AnswerGroup, (group) => group.puzzle)
  answerGroups: AnswerGroup[];
}
