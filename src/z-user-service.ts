import { Database } from "./database";

export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUsersByRole(role: string): Promise<unknown[]> {
    const query = `SELECT * FROM users WHERE role = '${role}'`;
    return this.db.execute(query);
  }

  computeAverage(scores: number[]): number {
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
}
