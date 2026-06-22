# Genuine bug fix fixture

This fixture models a repository where the base commit reproduces a failing behavior and the head
commit fixes it.

Tests create a temporary git repository from `base/`, commit it, apply `head/`, and run PatchProof
against those two commits.
