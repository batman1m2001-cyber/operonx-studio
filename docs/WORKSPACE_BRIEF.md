# OperonX Studio — Unified Project Execution & AI Development Workspace

> The owner's brief, 2026-11-01, kept as written. The plan is [WORKSPACE_PLAN.md](WORKSPACE_PLAN.md).

I want to evolve OperonX Studio from its current Project Builder and AI Assistant experience into a unified AI Development Workspace.

There are two major problems I want to address:

1. The current Project Builder experience is fragmented. Plans, Board cards, Checklist items, Questions, Changes, and Assistant executions do not consistently reflect the same project state.
2. The Studio currently lacks an integrated development environment where users and the Assistant can work with terminals, Git repositories, remote servers, and deployment environments.

I want these capabilities to become parts of one coherent system rather than a collection of disconnected tools.

This is an architectural and product-level improvement, not merely a UI redesign.

---

# PART I — UNIFIED PROJECT MANAGEMENT & EXECUTION

## 1. Establish One Source of Truth

Audit the current architecture of:

- Projects
- Plans
- Board and cards
- Backlog and task states
- Checklist and requirement verification
- Questions and decisions
- Assistant execution sessions
- Execution steps and progress events
- Git changes and commits
- Artifacts and evidence

Identify where the current data models, lifecycle management, and synchronization mechanisms are disconnected.

The fundamental requirement:

**Every project activity must be traceable to a unified project execution model.**

Introduce or adapt a consistent hierarchy:

Project
- Plan / Milestone
  - Task / Board Card
    - Execution Run
      - Execution Steps
      - Artifacts
      - Logs
      - Test Results
      - Git Changes
      - Evidence
  - Dependencies
  - Acceptance Criteria

Adapt this hierarchy to the existing data model. Do not create duplicate representations of information that already exists.

## 2. Board Must Reflect Actual Assistant Execution

This is the most important functional issue.

Currently, the Assistant can execute a large amount of work without the Board accurately reflecting what is happening.

Examples:
- The Assistant creates new tasks but they never appear on the Board.
- A task is being implemented but remains in Ready.
- The Assistant completes work but the Board does not reflect the actual result.
- Plans, checklists, and execution reports show inconsistent completion states.
- The user cannot determine which Board task the Assistant is currently working on.

Fix this systematically.

Requirements:

1. Every task created by the Assistant must be persisted and immediately appear in the appropriate Board.
2. Every execution must reference an existing Task/Card whenever it represents planned project work.
3. When execution starts, update the corresponding task lifecycle.
4. When execution completes, update the task based on actual results.
5. Failed executions must not be marked as completed.
6. Tasks awaiting review or QA must remain distinguishable from fully completed tasks.
7. Newly discovered work must be captured as new tasks or linked follow-up tasks instead of remaining buried in chat messages.
8. Maintain dependency relationships between tasks.
9. Keep Board, Plan, Checklist, and Assistant execution state synchronized.

Establish clear lifecycle semantics.

For example:

Backlog → Ready → In Progress → Review → QA → Done

Also support:
- Blocked
- Failed / Needs attention
- Cancelled
- Parked

Do not force every task through every stage. Adapt transitions to the actual workflow.

Crucially, distinguish between:
- Implementation completed.
- Tests passed.
- Review completed.
- Acceptance criteria verified.

These are not necessarily the same event.

Do not automatically mark a task Done simply because the Assistant has stopped executing.

## 3. Connect Assistant Execution to Board Tasks

The Assistant should understand the current Project, Plan, and Task context.

When executing a plan:

- Display which plan is currently being executed.
- Display the current Board task.
- Show its execution status and progress.
- Show completed and pending tasks.
- Respect dependencies and execution order.
- Update the Board as work progresses.
- Preserve execution history.

When a task is too large, the Assistant should be able to break it into smaller tasks or execution steps.

However, distinguish between:
- A real project task that belongs on the Board.
- An internal execution step that belongs inside an Execution Run.

Do not clutter the Board with every shell command, file read, or internal operation.

A task should be created when there is meaningful independently trackable project work, not for every tool invocation.

## 4. Unified Project Progress and Visualization

The user needs to understand the entire project execution flow without manually correlating different screens.

Improve the Project Builder with:

### Project Overview
- Overall project progress.
- Current active plan.
- Current active task.
- Completed / in-progress / blocked / pending tasks.
- Outstanding decisions.
- Outstanding requirements.
- Recent execution activity.

### Execution Graph
Provide a graph view showing:
- Plans and task dependencies.
- Execution sequence.
- Current active task.
- Completed and failed tasks.
- Blocked dependencies.
- Upcoming tasks.

The graph should reflect the actual project structure and execution state, not a separately maintained visualization.

### Task Detail
Selecting a task should reveal:
- Description and acceptance criteria.
- Dependencies.
- Current status.
- Linked Assistant executions.
- Execution progress.
- Relevant terminal sessions.
- Related Git branches, commits and PRs.
- Test results.
- Evidence and artifacts.

### Assistant Integration

The Assistant panel should be context-aware.

When the user selects a Board task, the Assistant should understand that task and its related context.

When the Assistant executes a task, the Board should visibly highlight the corresponding card.

The user should be able to navigate between the Assistant conversation, active task, and execution details without losing context.

---

# PART II — INTEGRATED DEVELOPMENT ENVIRONMENT

I also want to expand OperonX Studio with native development capabilities.

The objective is to allow users to manage the complete development lifecycle without constantly switching between the Studio, an external terminal, Git tools, and remote server management applications.

## 5. Integrated Terminal

Introduce a real terminal experience inside the Studio.

Requirements:

- Multiple terminal sessions.
- Terminal tabs and split panes.
- Interactive shell support.
- stdin/stdout/stderr streaming.
- Command history.
- Working directory management.
- Process lifecycle management.
- Start, stop, restart and terminate processes.
- Long-running command support.
- Output preservation and session recovery where feasible.

Terminal sessions must be able to run:
- Build commands.
- Test commands.
- Development servers.
- Scripts.
- Package managers.
- Arbitrary user-authorized shell commands.

The Assistant should be able to:
- Create and use terminal sessions.
- Execute commands.
- Observe outputs.
- Inspect errors.
- Continue working based on command results.
- Associate commands and sessions with relevant project tasks.

Important:

The terminal must be a real execution environment, not a simulated terminal UI.

Integrate it with the existing execution and progress infrastructure.

Do not introduce a separate process management system if the current execution engine can be extended safely.

## 6. Git Management

Expand the existing Git functionality into a proper source control experience.

Support:

### Repository
- Repository status.
- Current branch.
- Remote configuration.
- Fetch, pull and push.
- Multiple branches.

### Changes
- Changed files.
- Staged and unstaged changes.
- File-level diff.
- Line-level diff.
- Stage and unstage.
- Discard changes with explicit confirmation.

### History
- Commit history.
- Commit graph.
- Branch visualization.
- Commit details.
- File history.

### Collaboration
- Create and switch branches.
- Commit changes.
- Merge and rebase.
- Conflict inspection and resolution.
- Pull request creation and tracking where supported.

Connect Git operations to the Project Execution model.

For example:
- A task can have one or more related commits.
- An execution can create a branch.
- A pull request can reference its originating plan and tasks.
- A task can display its related code changes.

Preserve the existing Git safety mechanisms and commit identity settings.

Never silently discard uncommitted user changes.

## 7. Remote Server & SSH Management

Introduce remote execution environments.

Users should be able to configure and manage multiple remote environments.

Examples:
- Development
- Testing
- Staging
- Production

Support:

### SSH Connections
- SSH host configuration.
- Port and username.
- Private key authentication.
- Connection profiles.
- Host key verification.
- Connection testing.
- Connection lifecycle management.

### Remote Workspace
- Remote terminal sessions.
- Remote working directories.
- Repository checkout.
- Branch selection.
- File inspection where appropriate.
- Process management.
- Log streaming.
- Resource monitoring.

### Security

Treat remote credentials as sensitive information.

Requirements:
- Secure credential storage.
- Never expose private keys or passwords to the LLM.
- Never display raw secrets in logs.
- Redact sensitive environment variables.
- Verify SSH host identities.
- Separate permissions between environments.
- Require explicit authorization for destructive operations.
- Protect production environments with stricter approval requirements.

Do not implement SSH by simply exposing unrestricted shell commands to the Assistant.

Use a properly managed remote execution abstraction.

## 8. Environment Execution Abstraction

Design a reusable execution provider abstraction.

Potential providers:

- Local Workspace Provider
- Remote SSH Provider
- Container Provider (future extension)

All providers should expose a consistent execution interface.

The Assistant should be able to select an execution environment for a task without needing entirely different workflows for local and remote execution.

For example:

1. Implement code in the local repository.
2. Run local tests.
3. Create a Git commit.
4. Push the branch.
5. Select the staging environment.
6. Pull or checkout the corresponding branch remotely.
7. Install dependencies if required.
8. Start the application.
9. Run health checks and integration tests.
10. Report the results against the originating Board task.

All these activities should be traceable through the same execution model.

---

# PART III — RUN, TEST & DEPLOY

## 9. Application Runtime Management

Introduce application runtime management.

Users should be able to configure and manage runnable services.

Examples:
- Frontend development server.
- Backend API.
- Worker processes.
- Background services.
- Docker Compose applications.

Support:
- Start / stop / restart.
- Port management.
- Environment configuration.
- Runtime status.
- Logs.
- Health checks.
- Process monitoring.

When a web application is running, provide an accessible preview URL where supported.

The user should be able to inspect the running application without leaving the Studio.

## 10. Build, Test and Deployment Pipeline

Provide a lightweight deployment workflow that connects:

Git → Build → Test → Run → Validate → Deploy

Allow users to define environment-specific workflows.

Examples:

Local:
- Checkout branch.
- Install dependencies.
- Build.
- Run tests.
- Start development server.

Staging:
- Checkout branch.
- Build.
- Deploy.
- Start services.
- Run health checks.
- Validate endpoints.

Production:
- Require explicit user approval.
- Verify deployment target.
- Preserve deployment history.
- Provide rollback capabilities where supported.

Deployment must be observable.

The user should see:
- Current deployment stage.
- Current environment.
- Running processes.
- Logs.
- Test results.
- Health status.
- Deployment outcome.

Connect deployment events and evidence to the corresponding project tasks.

Do not build a heavyweight CI/CD platform unnecessarily. Start with a practical execution and deployment orchestration layer that can be extended later.

---

# PART IV — UNIFIED USER EXPERIENCE

## 11. Information Architecture

Review the current navigation and decide how these capabilities should fit into the existing Studio.

I do not want an overcrowded sidebar with dozens of unrelated destinations.

Consider a coherent structure such as:

Project
- Overview
- Board
- Plans
- Execution Graph
- Checklist
- Questions

Development
- Files
- Terminal
- Git
- Environments
- Deployments

Assistant
- Conversation
- Active Execution
- Execution History

This is a conceptual grouping, not a mandatory navigation design.

You may recommend a better information architecture based on the existing application.

The Assistant should remain accessible throughout the workflow.

## 12. Visual and Interaction Principles

Maintain the existing OperonX visual language.

Priorities:
- Clear information hierarchy.
- Compact but information-rich interfaces.
- Minimal unnecessary text.
- Strong visual distinction between execution states.
- Interactive progress visualization.
- Contextual details instead of overwhelming dashboards.
- Consistent navigation and shared context.
- Fast navigation between related entities.

Do not create separate dashboards that repeat the same information.

For example, task execution progress should be available from both the Board and Assistant, but both should reference the same underlying execution state.

The user should be able to understand:
- What the project is doing.
- What the Assistant is working on.
- Which task is currently active.
- What has already been completed.
- What is blocked.
- What remains.
- Where the code is running.
- Whether the application is healthy.

---

# PART V — IMPLEMENTATION STRATEGY

## 13. Audit Before Implementation

Before changing code, thoroughly inspect the current architecture.

Understand:
- Existing backend and frontend structure.
- Project and Plan data models.
- Board and Checklist implementation.
- Assistant session architecture.
- Execution event system.
- Existing progress tracking.
- Git integration.
- File management.
- Existing process execution capabilities.
- Persistence and synchronization mechanisms.

Identify reusable components and existing infrastructure.

Do not assume that the architecture described in this prompt already exists.

Do not invent new services or abstractions without first checking what is already available.

## 14. Prioritized Implementation Phases

Break implementation into independently testable phases.

### Phase 1 — Unified Project Execution Model
- Establish consistent project/task/execution relationships.
- Fix task creation and Board synchronization.
- Synchronize Plan, Board, Checklist and Assistant.
- Implement task-to-execution linking.
- Implement task-level progress and dependency tracking.
- Build the unified project overview and execution visualization.

### Phase 2 — Terminal & Git
- Implement real integrated terminal sessions.
- Improve Git management.
- Connect terminal and Git activities to project tasks.
- Ensure execution lifecycle consistency.

### Phase 3 — Remote SSH & Environments
- Implement secure SSH connections.
- Introduce execution providers.
- Support remote terminals and processes.
- Support remote repository operations.

### Phase 4 — Runtime & Deployment
- Implement application runtime management.
- Build/test/run workflows.
- Preview URLs.
- Staging deployments.
- Health checks and deployment history.
- Production deployment with approval safeguards.

Each phase must have:
- Clear acceptance criteria.
- Implementation tasks.
- Tests.
- Documentation updates.
- Board synchronization.

Do not start all phases simultaneously.

Prioritize architectural foundations and functional completeness over superficial UI coverage.

## 15. Engineering Constraints

- Preserve existing working functionality.
- Reuse existing architecture where appropriate.
- Avoid duplicate data models.
- Avoid introducing unnecessary dependencies.
- Avoid mock data and fake execution states.
- Do not fabricate progress or deployment results.
- Keep execution event handling efficient.
- Avoid unnecessary polling and LLM calls.
- Support long-running processes.
- Preserve user data and uncommitted changes.
- Implement appropriate authorization boundaries.
- Add integration tests for critical workflows.

If an existing architectural limitation prevents a requirement from being implemented correctly, explain it before introducing a workaround.

## 16. Expected Outcome

OperonX should become a unified AI Development Workspace where:

1. The Assistant understands the project structure.
2. The Assistant creates and manages real project tasks.
3. The Board accurately reflects what is happening.
4. The user can trace every execution back to its originating task.
5. The Assistant can work through an integrated terminal.
6. Git operations are available within the Studio.
7. Code can be executed locally or on remote servers.
8. Applications can be built, tested, previewed and deployed.
9. Results and evidence are reflected in the project lifecycle.

**The core principle: One Project, One Execution Model, Multiple Connected Views and Environments.**

The user should never need to manually reconcile the Board, Assistant, Checklist, Git history and execution logs to understand the state of a project.

Start by auditing the existing architecture, identifying the root causes of fragmentation, and proposing a concrete implementation plan for Phase 1.

Do not merely produce a design proposal. After the audit and plan, proceed with implementation phase by phase, keeping the project state and progress synchronized throughout.
