const RULES = [
  {
    industry: "\uac74\uc124\ud68c\uc0ac",
    include: ["\uac74\uc124", "\uac74\ucd95", "\uc885\ud569\uac74\uc124", "\uc2dc\uacf5", "\ud1a0\ubaa9", "\uc804\uae30\uacf5\uc0ac", "\uc124\ube44", "\uc124\ube44\uacf5\uc0ac"],
    exclude: ["\uc870\uacbd\uc790\uc7ac", "\uac74\uc124\uc790\uc7ac", "\ud560\uc778", "\ub300\uc5ec", "\ud310\ub9e4", "\uac74\uc124\uae30\uacc4", "\uc778\ud14c\ub9ac\uc5b4\uc18c\ud488"],
  },
  {
    industry: "\uc2dc\ud589\uc0ac",
    include: ["\uc2dc\ud589", "\uac1c\ubc1c", "\ub514\ubca8\ub85c\ud37c", "\ubd80\ub3d9\uc0b0\uac1c\ubc1c", "\uac74\uc124", "\uc885\ud569\uac74\uc124"],
    exclude: ["\ud589\uc0ac", "\uc758\ub8cc", "\uc790\ucd95", "\uae30\ub150\ubb3c", "\uad6c\uae09\ucc28"],
  },
  {
    industry: "\uc885\ud569\uac74\uc124",
    include: ["\uc885\ud569\uac74\uc124", "\uac74\uc124\uc5c5"],
    exclude: ["\uac74\uc124\uc790\uc7ac", "\uac74\uc124\uae30\uacc4", "\ub300\uc5ec", "\ud310\ub9e4", "\ud560\uc778"],
  },
  {
    industry: "\ubcd1\uc6d0",
    include: ["\ubcd1\uc6d0", "\uc758\uc6d0", "\uc758\ub8cc"],
    exclude: ["\uc758\ub8cc\uc6a9\ud488", "\uad6c\uae09\ucc28", "\ub3d9\ubb3c\ubcd1\uc6d0", "\ubc18\ub824\ub3d9\ubb3c", "\uc7a5\ub840\uc2dd\uc7a5", "\uc7a5\ub840"],
  },
  { industry: "\uc81c\uc870\uc5c5", include: ["\uc81c\uc870", "\uacf5\uc7a5", "\uc0b0\uc5c5", "\uae30\uacc4", "\uae08\uc18d", "\ud654\ud559", "\uc0dd\ud488"], exclude: [] },
  { industry: "\uc81c\uc870\uc5c5\uccb4", include: ["\uc81c\uc870", "\uacf5\uc7a5", "\uc0b0\uc5c5", "\uae30\uacc4", "\uae08\uc18d", "\ud654\ud559", "\uc0dd\ud488"], exclude: [] },
  { industry: "\ubc95\ubb34\ubc95\uc778", include: ["\ubc95\ubb34\ubc95\uc778", "\ubcc0\ud638\uc0ac", "\ubc95\ub960"], exclude: [] },
  { industry: "\uc138\ubb34\ubc95\uc778", include: ["\uc138\ubb34\ubc95\uc778", "\uc138\ubb34\uc0ac", "\uc138\ubb34"], exclude: [] },
  { industry: "\ud68c\uacc4\ubc95\uc778", include: ["\ud68c\uacc4\ubc95\uc778", "\ud68c\uacc4\uc0ac", "\ud68c\uacc4"], exclude: [] },
  { industry: "\uc790\ub3d9\ucc28 \ub51c\ub7ec", include: ["\uc790\ub3d9\ucc28", "\uc804\uc2dc\uc7a5", "\ub51c\ub7ec", "\uc218\uc785\ucc28"], exclude: ["\uc815\ube44", "\ubd80\ud488"] },
  { industry: "\uae08\uc735\uae30\uad00", include: ["\uae08\uc735", "\uc740\ud589", "\uc800\ucd95\uc740\ud589", "\uc2e0\ud611", "\uc0c8\ub9c8\uc744\uae08\uace0", "\uc99d\uad8c", "\ubcf4\ud5d8"], exclude: ["ATM", "\uc790\ub3d9\ud654\ucf54\ub108"] },
  { industry: "\ud504\ub79c\ucc28\uc774\uc988\ubcf8\uc0ac", include: ["\ud504\ub79c\ucc28\uc774\uc988", "\uac00\ub9f9\ubcf8\ubd80", "\ubcf8\uc0ac", "\uccb4\uc778"], exclude: ["\uac00\ub9f9\uc810", "\ub300\ub9ac\uc810"] },
  {
    industry: "\ud638\ud154",
    include: ["\ud638\ud154", "\ub9ac\uc870\ud2b8", "\uc219\ubc15"],
    exclude: ["\ubaa8\ud154", "\uc5ec\uad00", "\uc608\uc2dd\uc7a5", "\uc6e8\ub529\ud640", "\uacb0\ud63c"],
  },
];

export function isIndustryMatch(requestedIndustry, detailIndustry = "", companyName = "") {
  const rule = RULES.find((item) => item.industry === requestedIndustry);
  if (!rule) return true;

  const text = `${detailIndustry} ${companyName}`;
  if (rule.exclude.some((keyword) => text.includes(keyword))) return false;
  return rule.include.some((keyword) => text.includes(keyword));
}
