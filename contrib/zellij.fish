# Zellij tab naming integration (requires Zellij 0.44.0+)
# Uses --tab-id to target the correct tab even from background tabs.

# Unset the default fish greeting text which messes up Zellij
set fish_greeting

if status is-interactive
    # Specify the Zellij config dir, so we can launch it manually if we want to
    set -x ZELLIJ_CONFIG_DIR $HOME/.config/zellij

    # Check if our Terminal emulator is Ghostty
    if test "$TERM" = "xterm-ghostty"
        # Launch zellij
        eval (zellij setup --generate-auto-start fish | string collect)
    end
end

# Everything below only applies inside a Zellij session
if not set -q ZELLIJ
    exit
end

# Helper to get our tab ID from ZELLIJ_PANE_ID via list-panes --json
function __zellij_get_tab_id
    zellij action list-panes --json 2>/dev/null | jq -r --arg pid "$ZELLIJ_PANE_ID" '.[] | select(.id == ($pid | tonumber)) | .tab_id'
end

# Helper to truncate directory for tab display
function __zellij_fmt_dir
    set -l dirname (string replace $HOME '~' $PWD)
    if test (string length $dirname) -gt 30
        set dirname "..."(string sub -s -27 $dirname)
    end
    echo $dirname
end

# Tab name shows command while running - uses --tab-id to target the correct tab
# even if focus has moved to another tab (fixes background tab naming)
function zellij_tab_name_update --on-event fish_preexec
    set -g __zellij_tab_id (__zellij_get_tab_id)
    set -l dirname (__zellij_fmt_dir)
    set -l cmd "$argv"
    if test (string length $cmd) -gt 25
        set cmd (string sub -l 22 $cmd)"..."
    end
    set -l title "$cmd [$dirname]"
    zellij action rename-tab --tab-id $__zellij_tab_id $title
end

# Updates tab name to directory after command completes
# Uses --tab-id to always update the correct tab, even if it's in the background
function zellij_tab_name_update_postexec --on-event fish_postexec
    if set -q __zellij_tab_id
        set -l dirname (__zellij_fmt_dir)
        zellij action rename-tab --tab-id $__zellij_tab_id $dirname
        set -e __zellij_tab_id
    end
end

function zellij_tab_name_update_dir --on-variable PWD
    set -l tab_id (__zellij_get_tab_id)
    set -l dirname (__zellij_fmt_dir)
    zellij action rename-tab --tab-id $tab_id $dirname
end

# Set initial tab name when shell starts
set -l tab_id (__zellij_get_tab_id)
set -l dirname (__zellij_fmt_dir)
zellij action rename-tab --tab-id $tab_id $dirname
