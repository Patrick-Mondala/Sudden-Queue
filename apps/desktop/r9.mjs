import fs from "node:fs";
const p = "src/App.test.jsx";
let s = fs.readFileSync(p, "utf8");
const before = s;
const sub = (a, b) => { if (!s.includes(a)) { console.error("MISS:", a.slice(0,80)); process.exit(1); } s = s.split(a).join(b); };

sub(`import { act, cleanup, render, screen, waitFor } from "@testing-library/react";`,
`import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";`);

// The lobby has its own Invite button, so modal queries are scoped to the dialog.
sub(`  async function openInvites() {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Invite/i }));
    await screen.findByLabelText(/Search players/i);
  }`,
`  /** Opens the modal and returns it, so queries cannot stray into the lobby. */
  async function openInvites() {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Invite/i }));
    return screen.findByRole("dialog", { name: /Invite to party/i });
  }`);

sub(`  it("lists everyone online", async () => {
    await openInvites();
    for (const p of online) expect(screen.getByText(p.discordName)).toBeTruthy();
  });`,
`  it("lists everyone online", async () => {
    const modal = await openInvites();
    for (const p of online) expect(within(modal).getByText(p.discordName)).toBeTruthy();
  });`);

sub(`  it("shows someone already in a party without an Invite button", async () => {
    await openInvites();
    expect(screen.getByText("In a party")).toBeTruthy();
    // Two invitable players, so two buttons -- not three.
    expect(screen.getAllByRole("button", { name: /^Invite$/ })).toHaveLength(2);
  });`,
`  it("shows someone already in a party without an Invite button", async () => {
    const modal = await openInvites();
    expect(within(modal).getByText("In a party")).toBeTruthy();
    // Two invitable players, so two buttons.
    expect(within(modal).getAllByRole("button", { name: /^Invite$/ })).toHaveLength(2);
  });`);

sub(`  it("puts a player on cooldown after inviting them", async () => {
    await openInvites();
    const [first] = screen.getAllByRole("button", { name: /^Invite$/ });
    await userEvent.click(first);

    await waitFor(() => expect(server.invite).toHaveBeenCalledWith("user-2"));
    // The button explains itself rather than waiting to be refused.
    expect(await screen.findByRole("button", { name: /\d+s/ })).toBeTruthy();
  });`,
`  it("puts a player on cooldown after inviting them", async () => {
    const modal = await openInvites();
    await userEvent.click(within(modal).getAllByRole("button", { name: /^Invite$/ })[0]);

    await waitFor(() => expect(server.invite).toHaveBeenCalledWith("user-2"));
    // The button explains itself rather than waiting to be refused.
    expect(await within(modal).findByRole("button", { name: /\d+s/ })).toBeTruthy();
  });`);

sub(`    await openInvites();
    await userEvent.click(screen.getAllByRole("button", { name: /^Invite$/ })[0]);

    expect(await screen.findByRole("button", { name: /4[12]s/ })).toBeTruthy();`,
`    const modal = await openInvites();
    await userEvent.click(within(modal).getAllByRole("button", { name: /^Invite$/ })[0]);

    expect(await within(modal).findByRole("button", { name: /4[12]s/ })).toBeTruthy();`);

sub(`  it("filters as you type", async () => {
    await openInvites();
    await userEvent.type(screen.getByLabelText(/Search players/i), "bor");

    await waitFor(() => expect(screen.queryByText("Aria")).toBeNull());
    expect(screen.getByText("Boreas")).toBeTruthy();
  });`,
`  it("filters as you type", async () => {
    const modal = await openInvites();
    await userEvent.type(within(modal).getByLabelText(/Search players/i), "bor");

    await waitFor(() => expect(within(modal).queryByText("Aria")).toBeNull());
    expect(within(modal).getByText("Boreas")).toBeTruthy();
  });`);

sub(`  it("matches on in-game name too, since that is what people are called in game", async () => {
    await openInvites();
    await userEvent.type(screen.getByLabelText(/Search players/i), "CINDER");

    await waitFor(() => expect(screen.queryByText("Aria")).toBeNull());
    expect(screen.getByText("Cinder")).toBeTruthy();
  });`,
`  it("matches on in-game name too, since that is what people are called in game", async () => {
    const modal = await openInvites();
    await userEvent.type(within(modal).getByLabelText(/Search players/i), "CINDER");

    await waitFor(() => expect(within(modal).queryByText("Aria")).toBeNull());
    expect(within(modal).getByText("Cinder")).toBeTruthy();
  });`);

if (s === before) { console.error("NO CHANGE"); process.exit(1); }
fs.writeFileSync(p, s);
console.log("ok");
