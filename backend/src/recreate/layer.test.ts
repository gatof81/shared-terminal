import { describe, expect, it } from "vitest";
import {
	classifyLayer,
	ENTRYPOINT_SYMLINKS,
	type LayerChange,
	type LayerInput,
	type PathStat,
	parseGitconfig,
} from "./layer.js";

const H = "/home/developer";
const ID = { name: "Ada Lovelace", email: "ada@example.com" };
const GOOD_GITCONFIG = Buffer.from("[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n");

/** What a clean boot of the session image leaves in the layer, with its true shapes. */
function cleanBoot(): { changes: LayerChange[]; stats: Map<string, PathStat> } {
	const stats = new Map<string, PathStat>();
	for (const [link, target] of ENTRYPOINT_SYMLINKS)
		stats.set(link, { kind: "symlink", linkTarget: target });
	stats.set(`${H}/.config`, { kind: "dir" });
	stats.set("/tmp/.st-ready", { kind: "file" });
	stats.set("/tmp/tmux-1000", { kind: "dir" });
	stats.set("/tmp/tmux-1000/default", { kind: "socket" });
	for (const d of ["/home", H, "/tmp"]) stats.set(d, { kind: "dir" });
	stats.set(`${H}/uploads`, { kind: "dir" });
	const changes: LayerChange[] = [
		{ Path: "/home", Kind: 0 },
		{ Path: H, Kind: 0 },
		{ Path: `${H}/.npm-global`, Kind: 0 },
		{ Path: `${H}/.vscode-cli`, Kind: 1 },
		{ Path: `${H}/.config`, Kind: 1 },
		{ Path: `${H}/.config/gh`, Kind: 1 },
		{ Path: `${H}/.claude`, Kind: 1 },
		{ Path: `${H}/.claude.json`, Kind: 1 },
		{ Path: `${H}/.ssh`, Kind: 1 },
		{ Path: `${H}/uploads`, Kind: 1 },
		{ Path: "/tmp", Kind: 0 },
		{ Path: "/tmp/.st-ready", Kind: 1 },
		{ Path: "/tmp/tmux-1000", Kind: 1 },
		{ Path: "/tmp/tmux-1000/default", Kind: 1 },
	];
	return { changes, stats };
}

function input(patch: Partial<LayerInput> & { stats?: Map<string, PathStat> } = {}): LayerInput {
	const base = cleanBoot();
	const stats = patch.stats ?? base.stats;
	return {
		changes: patch.changes ?? base.changes,
		stat: async (p) => stats.get(p) ?? null,
		mounts: patch.mounts ?? [`${H}/workspace`, `${H}/uploads`],
		gitconfig: patch.gitconfig ?? (async () => null),
		identity: patch.identity === undefined ? ID : patch.identity,
		hasDotfiles: patch.hasDotfiles ?? false,
	};
}

describe("classifyLayer (§2.7.1 precondition 6)", () => {
	it("a clean entrypoint boot is lossless", async () => {
		expect(await classifyLayer(input())).toEqual({ blockers: [], reapplyGitIdentity: false });
	});

	it("what the bind mounts hold is never part of the layer", async () => {
		const { changes } = cleanBoot();
		changes.push({ Path: `${H}/workspace/anything`, Kind: 1 });
		expect((await classifyLayer(input({ changes }))).blockers).toEqual([]);
	});

	for (const link of ENTRYPOINT_SYMLINKS.keys()) {
		it(`wrong shape at ${link.replace(H, "~")}: a real dir, or a symlink elsewhere, blocks layer-home`, async () => {
			for (const wrong of [
				{ kind: "dir" } as PathStat,
				{ kind: "symlink", linkTarget: "/tmp/elsewhere" } as PathStat,
				{ kind: "symlink", linkTarget: `${ENTRYPOINT_SYMLINKS.get(link)}/` } as PathStat,
			]) {
				const { stats } = cleanBoot();
				stats.set(link, wrong);
				expect((await classifyLayer(input({ stats }))).blockers).toEqual([
					{ code: "layer-home", count: 1 },
				]);
			}
		});
	}

	it("~/.config, the sentinel, the relay log and the tmux dir must have their type", async () => {
		for (const [p, wrong] of [
			[`${H}/.config`, "file"],
			["/tmp/.st-ready", "dir"],
			["/tmp/tmux-1000", "file"],
			["/tmp/tmux-1000/default", "file"],
		] as const) {
			const { stats } = cleanBoot();
			stats.set(p, { kind: wrong });
			const code = p.startsWith("/tmp") ? "layer-tmp" : "layer-home";
			expect((await classifyLayer(input({ stats }))).blockers).toEqual([{ code, count: 1 }]);
		}
		const { changes, stats } = cleanBoot();
		changes.push({ Path: "/tmp/st-relay.log", Kind: 1 });
		stats.set("/tmp/st-relay.log", { kind: "file" });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([]);
	});

	it("everything else blocks by category, with counts and never paths", async () => {
		const { changes, stats } = cleanBoot();
		changes.push(
			{ Path: `${H}/.bash_history`, Kind: 1 },
			{ Path: `${H}/.npm`, Kind: 1 },
			{ Path: `${H}/.npm/_cacache`, Kind: 1 },
			{ Path: "/tmp/build.log", Kind: 1 },
			{ Path: "/etc/apt/sources.list", Kind: 0 },
			{ Path: "/usr/local/bin/tool", Kind: 1 },
			{ Path: "/var/log/x", Kind: 2 },
		);
		const v = await classifyLayer(input({ changes, stats }));
		expect(v.blockers).toEqual([
			{ code: "layer-home", count: 3 },
			{ code: "layer-tmp", count: 1 },
			{ code: "layer-system", count: 3 },
		]);
		expect(JSON.stringify(v)).not.toContain("bash_history");
	});

	it("a changed parent dir is allowed only as an ancestor of something allowed", async () => {
		const { changes } = cleanBoot();
		changes.push({ Path: "/etc", Kind: 0 });
		const { stats } = cleanBoot();
		stats.set("/etc", { kind: "dir" });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([
			{ code: "layer-system", count: 1 },
		]);
		// …but /etc is an ancestor of the control mount point of a 3.0d O.
		expect(
			(
				await classifyLayer(
					input({ changes, stats, mounts: [`${H}/workspace`, `${H}/uploads`, "/etc/st-control"] }),
				)
			).blockers,
		).toEqual([]);
	});

	it("deletions under ~/.npm-global count only once the symlink is verified exact", async () => {
		const { changes, stats } = cleanBoot();
		changes.push({ Path: `${H}/.npm-global/lib/node_modules`, Kind: 2 });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([]);
		stats.set(`${H}/.npm-global`, { kind: "dir" });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([
			{ code: "layer-home", count: 2 },
		]);
	});

	describe("~/.gitconfig", () => {
		const withGitconfig = (buf: Buffer | "unreadable", identity: typeof ID | null = ID) => {
			const { changes } = cleanBoot();
			changes.push({ Path: `${H}/.gitconfig`, Kind: 1 });
			return input({ changes, gitconfig: async () => buf, identity });
		};
		it("exactly user.name and user.email equal to session_configs ⇒ allowed, gitIdentity re-run", async () => {
			expect(await classifyLayer(withGitconfig(GOOD_GITCONFIG))).toEqual({
				blockers: [],
				reapplyGitIdentity: true,
			});
		});
		for (const [label, text] of [
			[
				"an extra key",
				"[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n[core]\n\teditor = vim\n",
			],
			["another email", "[user]\n\tname = Ada Lovelace\n\temail = other@example.com\n"],
			["a comment", "# mine\n[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n"],
			[
				"an include",
				"[include]\n\tpath = x\n[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
			],
			[
				"a duplicated key",
				"[user]\n\tname = Ada Lovelace\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
			],
		] as const) {
			it(`${label} ⇒ layer-gitconfig-modified`, async () => {
				expect((await classifyLayer(withGitconfig(Buffer.from(text)))).blockers).toEqual([
					{ code: "layer-gitconfig-modified", count: 1 },
				]);
			});
		}
		it("no identity configured, oversized or unreadable ⇒ layer-gitconfig-modified", async () => {
			expect((await classifyLayer(withGitconfig(GOOD_GITCONFIG, null))).blockers).toEqual([
				{ code: "layer-gitconfig-modified", count: 1 },
			]);
			expect((await classifyLayer(withGitconfig("unreadable"))).blockers).toEqual([
				{ code: "layer-gitconfig-modified", count: 1 },
			]);
		});
		it("quoted values the way git writes them", () => {
			expect(parseGitconfig('[user]\n\tname = " Ada \\"L\\" "\n')?.get("user.name")).toEqual([
				' Ada "L" ',
			]);
			expect(parseGitconfig("[user]\n\tname = a # b\n")).toBeNull();
		});
	});

	it("dotfiles configured ⇒ layer-dotfiles, whatever the layer holds", async () => {
		expect((await classifyLayer(input({ hasDotfiles: true }))).blockers).toEqual([
			{ code: "layer-dotfiles", count: 1 },
		]);
	});
});
