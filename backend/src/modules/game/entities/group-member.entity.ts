import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from "typeorm";
import { AnswerGroup } from "./answer-group.entity";

@Entity("GroupMember")
@Index("UQ_GroupMember_group_word", ["group", "word"], { unique: true })
export class GroupMember {
  @PrimaryGeneratedColumn("identity")
  id!: number;

  @Column({ type: "text" })
  word!: string;

  @Column({ type: "integer" })
  position!: number;

  @ManyToOne(() => AnswerGroup, (group) => group.members, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "group_id" })
  group!: AnswerGroup;
}
