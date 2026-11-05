package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func init() {
	issueCommentCmd.AddCommand(newIssueCommentReactionCmd())
}

func newIssueCommentReactionCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "reaction",
		Short: "Add or remove a comment reaction as the authenticated actor",
		Long: "React to a specific comment. In an agent run, identity comes from the task token. " +
			"Add and remove are idempotent: retrying add keeps the existing reaction; it never toggles it off. " +
			"A reaction acknowledges a message without changing issue status or starting a comment reply run.",
	}
	for _, action := range []string{"add", "remove"} {
		child := &cobra.Command{
			Use:   action + " <comment-id>",
			Short: strings.ToUpper(action[:1]) + action[1:] + " an emoji reaction",
			Args:  exactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				emoji, _ := cmd.Flags().GetString("emoji")
				if strings.TrimSpace(emoji) == "" {
					return fmt.Errorf("--emoji is required")
				}
				output, _ := cmd.Flags().GetString("output")
				if output != "json" && output != "table" {
					return fmt.Errorf("--output must be table or json")
				}
				client, err := newAPIClient(cmd)
				if err != nil {
					return err
				}
				ctx, cancel := cli.APIContext(context.Background())
				defer cancel()
				path := "/api/comments/" + url.PathEscape(args[0]) + "/reactions"
				body := map[string]string{"emoji": emoji}
				var result map[string]any
				if action == "add" {
					err = client.PostJSON(ctx, path, body, &result)
				} else {
					err = client.DeleteJSONWithBody(ctx, path, body)
					result = map[string]any{"comment_id": args[0], "emoji": emoji, "removed": true}
				}
				if err != nil {
					return fmt.Errorf("%s comment reaction: %w", action, err)
				}
				fmt.Fprintf(os.Stderr, "Comment reaction %s succeeded.\n", action)
				if output == "table" {
					return nil
				}
				return cli.PrintJSON(os.Stdout, result)
			},
		}
		child.Flags().String("emoji", "", "Emoji to add or remove, for example 👌")
		child.Flags().String("output", "json", "Output format: table or json")
		cmd.AddCommand(child)
	}
	return cmd
}
