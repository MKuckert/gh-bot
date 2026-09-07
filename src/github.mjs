// github.mjs — thin REST helpers for the bot round, built on AppAuth.

export class GitHub {
  /** @param {import("./auth.mjs").AppAuth} auth */
  constructor(auth, { repo = process.env.GH_REPO ?? "MKuckert/env" } = {}) {
    this.auth = auth;
    this.repo = repo;
  }

  /** Open issues only (pull requests filtered out). */
  async listOpenIssues() {
    const issues = await this.auth.request(`/repos/${this.repo}/issues?state=open&per_page=100`);
    return issues.filter((i) => !i.pull_request);
  }

  /** All comments for one issue, oldest → newest. */
  async getComments(issue) {
    return this.auth.request(`/repos/${this.repo}/issues/${issue.number}/comments?per_page=100`);
  }

  async postComment(issue, body) {
    return this.auth.request(`/repos/${this.repo}/issues/${issue.number}/comments`, {
      method: "POST",
      body: { body },
    });
  }
}
