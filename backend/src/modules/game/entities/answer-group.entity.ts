import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from "typeorm";
import { Puzzle } from "./puzzle.entity";
import { GroupMember } from "./group-member.entity";

@Entity("AnswerGroup")
export class AnswerGroup {
  @PrimaryGeneratedColumn("identity")
  id!: number;

  @Column({ type: "text" })
  group_name!: string;

  @Column({ type: "integer" })
  level!: number;

  @ManyToOne(() => Puzzle, (puzzle) => puzzle.answerGroups, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "puzzle_id" })
  puzzle!: Puzzle;

  @OneToMany(() => GroupMember, (member) => member.group)
  members!: GroupMember[];
}
