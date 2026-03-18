# Shell Integration Setup

Quick guide to enable autocomplete and PR# in your shell prompt.

## 🚀 Quick Install (Recommended)

Run the automated installer:

```bash
./scripts/install-shell-integration.sh
```

Follow the prompts and choose:
- **Option 3** (Both) for full integration
- Then run: `source ~/.zshrc` (or `~/.bashrc` for bash)

---

## ✋ Manual Setup

### 1. Autocomplete

```bash
# Install completion
kunj completion --install

# Reload your shell
source ~/.zshrc  # for zsh
source ~/.bashrc # for bash
```

Now you can use tab completion:
```bash
kunj <TAB>        # Shows all commands
kunj pr <TAB>     # Shows PR options
```

### 2. PR# in Shell Prompt

#### Zsh

Add to `~/.zshrc`:

```zsh
# Show PR# in prompt
kunj_prompt_pr() {
  local pr=$(kunj prompt-info 2>/dev/null)
  [ -n "$pr" ] && echo " %F{blue}$pr%f"
}
RPROMPT='$(kunj_prompt_pr)'
```

#### Bash

Add to `~/.bashrc`:

```bash
# Show PR# in prompt
kunj_prompt_pr() {
  local pr=$(kunj prompt-info 2>/dev/null)
  [ -n "$pr" ] && echo " $pr"
}
PS1="${PS1%\\$ }\$(kunj_prompt_pr)\\$ "
```

#### Using Provided Scripts

Or source the provided scripts:

```bash
# For Zsh
echo 'source /path/to/kunj/scripts/kunj-prompt.zsh' >> ~/.zshrc

# For Bash
echo 'source /path/to/kunj/scripts/kunj-prompt.bash' >> ~/.bashrc
```

---

## 📸 What It Looks Like

### Before
```
~/projects/myapp (feature-branch) $
```

### After
```
~/projects/myapp (feature-branch)                    #123
```

The PR# appears in your prompt when you're on a branch with an associated pull request!

---

## 🎨 Customization

### Change PR# Color (zsh)

```zsh
kunj_prompt_pr() {
  local pr=$(kunj prompt-info 2>/dev/null)
  [ -n "$pr" ] && echo " %F{cyan}$pr%f"  # cyan instead of blue
}
```

Available colors: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`

### Show More Info

```zsh
# Show branch name + PR# + status
kunj_prompt_pr() {
  local pr=$(kunj prompt-info --format detailed --show-branch --show-status 2>/dev/null)
  [ -n "$pr" ] && echo " %F{cyan}[$pr]%f"
}
```

Output: `[feature-branch PR#123 OPEN]`

### Different Position

```zsh
# Left prompt instead of right
PROMPT='$(kunj_prompt_pr) %~ $ '

# Both sides
PROMPT='%~ $ '
RPROMPT='$(kunj_prompt_pr)'
```

---

## 🔧 Troubleshooting

### PR# not showing?

1. Make sure you have a PR for your branch:
   ```bash
   kunj pr
   ```

2. Test manually:
   ```bash
   kunj prompt-info
   ```

3. Check metadata:
   ```bash
   cat .kunj/branches.json
   ```

### Autocomplete not working?

1. Verify kunj is in PATH:
   ```bash
   which kunj
   ```

2. Reinstall completion:
   ```bash
   kunj completion --uninstall
   kunj completion --install
   source ~/.zshrc
   ```

### Slow prompt?

The `prompt-info` command is optimized to be fast (uses cached metadata), but if you're experiencing slowness:

1. Don't use `--show-status` flag (requires GitHub API call)
2. Check your network connection
3. Ensure `gh` CLI is authenticated: `gh auth status`

---

## 📚 More Info

- Full documentation: `docs/SHELL_INTEGRATION.md`
- All docs: `docs/README.md`
- Project README: `README.md`

---

## 🎉 Enjoy!

You now have:
- ✅ Tab completion for all kunj commands
- ✅ PR# displayed in your shell prompt
- ✅ Quick access to PR status

Happy branching! 🚀
