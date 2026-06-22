from calculator import add

if add(2, 2) != 4:
    print("bug reproduced")
    raise SystemExit(1)
