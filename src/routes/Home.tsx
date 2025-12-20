import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { motion, type Variants } from "framer-motion";
import { fetchNotionItems, submitVotes, verifyVoteKey } from "../api/notion";
import type { NotionItem, NotionPropertyValue } from "../types/notion";

const MAX_VOTES_PER_CATEGORY = 2;

const CATEGORY_ORDER = [
  "年度最佳充电产品",
  "最佳高性能移动电源",
  "最佳便携式移动电源",
  "最佳高性能充电器",
  "最佳便携式充电器",
  "最佳桌面充电站",
  "最佳充电与数据传输线缆",
  "最佳无线充电配件",
  "最佳快充体验手机",
  "最佳快充测试仪",
  "最佳能效表现奖",
  "最佳外观设计奖",
  "最佳性价比奖",
  "最佳交互体验奖",
  "年度技术创新",
  "年度创意设计",
] as const;
const CATEGORY_ORDER_LOOKUP: Map<string, number> = new Map(
  CATEGORY_ORDER.map((name, index) => [name, index]),
);

const CATEGORY_MATCHERS = [
  "参与项目",
  "项目分类",
  "奖项",
  "分类",
  "类别",
  "赛道",
  "award",
  "category",
  "track",
];
const NAME_MATCHERS: Array<string | RegExp> = [
  /^名称/,
  "项目名称",
  "产品名称",
  "作品名称",
  "项目名",
  "产品名",
  /name/i,
];
const ORDER_MATCHERS = ["序号", "顺序", "排序", "编号", "order", "index", "no"];
const BRAND_MATCHERS = ["品牌", "brand", "厂商", "制造商"];
const MODEL_MATCHERS = ["型号", "model", "机型"];
const SPECS_MATCHERS = ["技术规格", "规格", "参数", "spec", "specs"];
const REASON_MATCHERS = ["推荐理由", "推荐", "理由", "recommend", "reason"];
const IMAGE_MATCHERS = ["图片", "image", "封面", "主图", "photo", "cover"];

type ItemView = {
  id: string;
  title: string;
  brand: string;
  model: string;
  specs: string;
  reason: string;
  image: string;
  category: string;
  order: number;
  displayName: string;
};

type VoteState = Record<string, Record<string, number>>;
type PageDirection = "next" | "prev";

const SWIPE_EDGE_THRESHOLD = 36;
const EDGE_TOLERANCE = 2;
const OUTER_SCROLL_TOLERANCE = 6;
const PAGE_SCROLL_COOLDOWN_MS = 650;

function normalizeText(value: NotionPropertyValue | undefined) {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value;
}

function matchesName(name: string, matcher: string | RegExp) {
  if (matcher instanceof RegExp) {
    return matcher.test(name);
  }
  return name.toLowerCase().includes(matcher.toLowerCase());
}

function findPropertyValue(item: NotionItem, matchers: Array<string | RegExp>) {
  for (const property of item.properties) {
    if (matchers.some((matcher) => matchesName(property.name, matcher))) {
      return property.value;
    }
  }
  return undefined;
}

function findFirstUrl(value: NotionPropertyValue | undefined, fallback = "") {
  if (!value && fallback) {
    return fallback;
  }
  const candidates = Array.isArray(value) ? value : [value];
  const match = candidates.find(
    (item) => typeof item === "string" && item.startsWith("http"),
  );
  return match || fallback || "";
}

function parseOrder(value: NotionPropertyValue | undefined) {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return Number.MAX_SAFE_INTEGER;
  }
  const numeric = Number.parseFloat(String(raw).replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

export default function Home() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [votes, setVotes] = useState<VoteState>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [inviteInfoOpen, setInviteInfoOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [voteKeyId, setVoteKeyId] = useState<string | null>(null);
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [isKeySubmitting, setIsKeySubmitting] = useState(false);
  const [categorySelectorAnchor, setCategorySelectorAnchor] = useState<
    string | null
  >(null);
  const isCategorySelectorOpen = categorySelectorAnchor !== null;
  const homeRef = useRef<HTMLDivElement>(null);
  const pagingLock = useRef(false);
  const touchStateRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    containerStartScrollTop: number;
    activeScrollable: HTMLElement | null;
    edgeDirection: PageDirection | null;
    edgeStartY: number | null;
    isActive: boolean;
  }>({
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    containerStartScrollTop: 0,
    activeScrollable: null,
    edgeDirection: null,
    edgeStartY: null,
    isActive: false,
  });

  function toggleCategorySelector(name: string) {
    setCategorySelectorAnchor((prev) => (prev === name ? null : name));
  }

  function scrollToCategory(name: string) {
    // Find section by id or data attribute
    const sections = document.querySelectorAll(".category-page");
    for (const section of sections) {
      if (section.querySelector("h2")?.textContent?.includes(name)) {
        section.scrollIntoView({ behavior: "smooth" });
        break;
      }
    }
    setCategorySelectorAnchor(null);
  }

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["notion-items"],
    queryFn: fetchNotionItems,
  });

  useEffect(() => {
    const container = homeRef.current;
    if (!container) {
      return;
    }
    const isCoarsePointer = Boolean(
      window.matchMedia?.("(pointer: coarse)")?.matches ||
      window.matchMedia?.("(max-width: 768px)")?.matches,
    );
    if (!isCoarsePointer) {
      return;
    }

    const resetTouchState = () => {
      const state = touchStateRef.current;
      state.isActive = false;
      state.activeScrollable = null;
      state.edgeDirection = null;
      state.edgeStartY = null;
      state.containerStartScrollTop = 0;
    };

    const getScrollableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      return target.closest(".entries-container") as HTMLElement | null;
    };

    const isModalTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      return Boolean(target.closest(".modal, .modal-backdrop"));
    };

    const getSections = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          ".page-hero, .category-page, .submit-page",
        ),
      );

    const getActiveSectionIndex = (sections: HTMLElement[]) => {
      const midPoint = container.scrollTop + container.clientHeight / 2;
      for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index];
        const start = section.offsetTop;
        const end = start + section.offsetHeight;
        if (midPoint >= start && midPoint < end) {
          return index;
        }
      }
      return 0;
    };

    const scrollToSection = (section: HTMLElement) => {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const onTouchStart = (event: TouchEvent) => {
      resetTouchState();
      if (keyModalOpen || reviewOpen || isCategorySelectorOpen) {
        return;
      }
      if (event.touches.length !== 1) {
        return;
      }
      if (isModalTarget(event.target)) {
        return;
      }
      const touch = event.touches[0];
      const state = touchStateRef.current;
      state.startX = touch.clientX;
      state.startY = touch.clientY;
      state.lastX = touch.clientX;
      state.lastY = touch.clientY;
      state.containerStartScrollTop = container.scrollTop;
      state.activeScrollable = getScrollableTarget(event.target);
      state.isActive = Boolean(state.activeScrollable);
    };

    const onTouchMove = (event: TouchEvent) => {
      const state = touchStateRef.current;
      if (!state.isActive || !state.activeScrollable) {
        return;
      }
      if (event.touches.length !== 1) {
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - state.lastX;
      const deltaY = touch.clientY - state.lastY;
      state.lastX = touch.clientX;
      state.lastY = touch.clientY;

      if (Math.abs(deltaY) <= Math.abs(deltaX)) {
        state.edgeDirection = null;
        state.edgeStartY = null;
        return;
      }

      const direction: PageDirection = deltaY < 0 ? "next" : "prev";
      const scrollable = state.activeScrollable;
      const atTop = scrollable.scrollTop <= EDGE_TOLERANCE;
      const atBottom =
        scrollable.scrollTop + scrollable.clientHeight >=
        scrollable.scrollHeight - EDGE_TOLERANCE;
      const isAtEdge = direction === "next" ? atBottom : atTop;

      if (!isAtEdge) {
        state.edgeDirection = null;
        state.edgeStartY = null;
        return;
      }

      if (state.edgeDirection !== direction) {
        state.edgeDirection = direction;
        state.edgeStartY = touch.clientY;
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      const state = touchStateRef.current;
      if (!state.isActive) {
        return;
      }
      if (event.changedTouches.length === 1) {
        const touch = event.changedTouches[0];
        state.lastX = touch.clientX;
        state.lastY = touch.clientY;
      }

      const edgeDirection = state.edgeDirection;
      const edgeStartY = state.edgeStartY;
      const outerScrollDelta = Math.abs(
        container.scrollTop - state.containerStartScrollTop,
      );
      resetTouchState();

      if (!edgeDirection || edgeStartY == null) {
        return;
      }
      if (outerScrollDelta > OUTER_SCROLL_TOLERANCE) {
        return;
      }
      const edgeDelta = state.lastY - edgeStartY;
      const isSwipeEnough =
        edgeDirection === "next"
          ? edgeDelta < -SWIPE_EDGE_THRESHOLD
          : edgeDelta > SWIPE_EDGE_THRESHOLD;
      if (!isSwipeEnough) {
        return;
      }
      if (pagingLock.current) {
        return;
      }
      pagingLock.current = true;
      window.setTimeout(() => {
        pagingLock.current = false;
      }, PAGE_SCROLL_COOLDOWN_MS);

      const sections = getSections();
      if (sections.length === 0) {
        return;
      }
      const currentIndex = getActiveSectionIndex(sections);
      const nextIndex =
        edgeDirection === "next"
          ? Math.min(sections.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
      if (nextIndex !== currentIndex) {
        scrollToSection(sections[nextIndex]);
      }
    };

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [keyModalOpen, reviewOpen, inviteInfoOpen, isCategorySelectorOpen, isLoading, isError]);

  const items = data?.items ?? [];
  const votingUnlocked = Boolean(voteKeyId);

  const viewItems = useMemo(() => {
    return items.map((item) => {
      const rawTitle = item.title || "";
      const name = normalizeText(findPropertyValue(item, NAME_MATCHERS));
      const title = name || rawTitle || "未命名项目";
      const brand = normalizeText(findPropertyValue(item, BRAND_MATCHERS));
      const model = normalizeText(findPropertyValue(item, MODEL_MATCHERS));
      const specs = normalizeText(findPropertyValue(item, SPECS_MATCHERS));
      const reason = normalizeText(findPropertyValue(item, REASON_MATCHERS));
      const category =
        normalizeText(findPropertyValue(item, CATEGORY_MATCHERS)) || "未分类";
      let order = parseOrder(findPropertyValue(item, ORDER_MATCHERS));
      if (order === Number.MAX_SAFE_INTEGER) {
        order = parseOrder(rawTitle);
      }
      const image = findFirstUrl(
        findPropertyValue(item, IMAGE_MATCHERS),
        item.cover,
      );
      const displayName = brand ? `${brand} ${title}` : title;

      return {
        id: item.id,
        title,
        brand,
        model,
        specs,
        reason,
        category,
        order,
        image,
        displayName,
      };
    });
  }, [items]);

  const itemLookup = useMemo(() => {
    const lookup = new Map<string, ItemView>();
    for (const item of viewItems) {
      lookup.set(item.id, item);
    }
    return lookup;
  }, [viewItems]);

  const groupedItems = useMemo(() => {
    const groups = new Map<string, ItemView[]>();
    for (const item of viewItems) {
      const key = item.category;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    const collator = new Intl.Collator("zh-Hans-CN", {
      numeric: true,
      sensitivity: "base",
    });
    const getCategoryRank = (name: string) =>
      CATEGORY_ORDER_LOOKUP.get(name.trim()) ?? Number.MAX_SAFE_INTEGER;
    return Array.from(groups.entries())
      .map(([name, group]) => ({
        name,
        items: [...group].sort(
          (a, b) => a.order - b.order || collator.compare(a.title, b.title),
        ),
      }))
      .sort((a, b) => {
        const rankA = getCategoryRank(a.name);
        const rankB = getCategoryRank(b.name);
        if (rankA !== rankB) {
          return rankA - rankB;
        }
        return collator.compare(a.name, b.name);
      });
  }, [viewItems]);

  function scrollToFirstCategory() {
    const firstCategory = document.querySelector(".category-page");
    if (firstCategory) {
      firstCategory.scrollIntoView({ behavior: "smooth" });
    }
  }

  function startVoting() {
    if (!votingUnlocked) {
      openKeyModal();
      return;
    }
    scrollToFirstCategory();
  }

  function getCategoryVotes(category: string) {
    return votes[category] ?? {};
  }

  function getCategoryTotal(category: string) {
    return Object.values(getCategoryVotes(category)).reduce(
      (sum, count) => sum + count,
      0,
    );
  }

  function incrementVote(category: string, id: string) {
    setVotes((prev) => {
      const currentCategory = prev[category] ?? {};
      const total = Object.values(currentCategory).reduce(
        (sum, count) => sum + count,
        0,
      );
      const currentCount = currentCategory[id] ?? 0;
      if (
        total >= MAX_VOTES_PER_CATEGORY ||
        currentCount >= MAX_VOTES_PER_CATEGORY
      ) {
        return prev;
      }
      return {
        ...prev,
        [category]: {
          ...currentCategory,
          [id]: currentCount + 1,
        },
      };
    });
  }

  function decrementVote(category: string, id: string) {
    setVotes((prev) => {
      const currentCategory = prev[category] ?? {};
      const currentCount = currentCategory[id] ?? 0;
      if (currentCount <= 0) {
        return prev;
      }
      const nextCount = currentCount - 1;
      const nextCategory = { ...currentCategory };
      if (nextCount === 0) {
        delete nextCategory[id];
      } else {
        nextCategory[id] = nextCount;
      }
      if (Object.keys(nextCategory).length === 0) {
        const nextVotes = { ...prev };
        delete nextVotes[category];
        return nextVotes;
      }
      return { ...prev, [category]: nextCategory };
    });
  }

  function openKeyModal() {
    setKeyError(null);
    setKeyModalOpen(true);
  }

  function closeKeyModal() {
    if (!isKeySubmitting) {
      setKeyModalOpen(false);
    }
  }

  function openInviteInfoFromKeyModal() {
    if (isKeySubmitting) {
      return;
    }
    setInviteInfoOpen(true);
    setKeyModalOpen(false);
  }

  async function handleKeySubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const trimmedKey = keyInput.trim();
    if (!trimmedKey) {
      setKeyError("请输入邀请码。");
      return;
    }
    setIsKeySubmitting(true);
    setKeyError(null);
    try {
      const response = await verifyVoteKey(trimmedKey);
      setVoteKeyId(response.keyId);
      setKeyInput("");
      setKeyModalOpen(false);
      scrollToFirstCategory();
    } catch (submitError) {
      setKeyError(
        submitError instanceof Error ? submitError.message : "验证失败。",
      );
    } finally {
      setIsKeySubmitting(false);
    }
  }

  function openReview() {
    if (!votingUnlocked) {
      openKeyModal();
      return;
    }
    setSubmitError(null);
    setSubmitSuccess(false);
    setReviewOpen(true);
  }

  function closeReview() {
    if (!isSubmitting) {
      setReviewOpen(false);
    }
  }

  async function handleSubmit() {
    if (!votingUnlocked || !voteKeyId) {
      setSubmitError("请先输入投票密码。");
      openKeyModal();
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const payload = Object.entries(votes).flatMap(([category, items]) =>
        Object.entries(items).map(([id, count]) => ({
          id,
          count,
          category,
        })),
      );
      const results = payload.map((vote) => {
        const item = itemLookup.get(vote.id);
        return {
          id: vote.id,
          category: vote.category ?? "",
          count: vote.count,
          title: item?.title ?? "",
          brand: item?.brand ?? "",
          model: item?.model ?? "",
          specs: item?.specs ?? "",
          reason: item?.reason ?? "",
        };
      });
      const resultPayload = {
        submittedAt: new Date().toISOString(),
        totalVotes,
        votes: results,
      };

      await submitVotes({
        votes: payload,
        keyId: voteKeyId,
        results: resultPayload,
      });
      setSubmitSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["notion-items"] });
      // Short delay or immediate redirect
      navigate({ to: "/thank-you" });
    } catch (submitError) {
      setSubmitError(
        submitError instanceof Error ? submitError.message : "提交失败。",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const totalVotes = Object.values(votes).reduce(
    (sum, categoryVotes) =>
      sum + Object.values(categoryVotes).reduce((acc, count) => acc + count, 0),
    0,
  );

  // Animation variants
  const heroContainerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.2,
      },
    },
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
  };

  const selectorPanelVariants: Variants = {
    hidden: { opacity: 0, scale: 0.96, y: -6 },
    visible: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: { type: "spring", stiffness: 320, damping: 24 },
    },
  };

  const selectorListVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.05, delayChildren: 0.08 },
    },
  };

  const selectorItemVariants: Variants = {
    hidden: { opacity: 0, y: 8, filter: "blur(4px)" },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: { duration: 0.35, ease: "easeOut" },
    },
  };

  const titleCharVariants: Variants = {
    hidden: { y: "100%", opacity: 0 },
    visible: {
      y: 0,
      opacity: 1,
      transition: {
        duration: 0.8,
        ease: "backOut" as const,
      },
    },
  };

  const AnimatedTitle = ({ lines }: { lines: string[] }) => {
    const maxLineDuration = Math.max(
      ...lines.map(
        (line, index) =>
          index * 0.2 + Math.max(0, line.length - 1) * 0.06 + 0.8,
      ),
    );
    const sweepStyle = {
      "--sweep-delay": `${maxLineDuration + 0.15}s`,
    } as CSSProperties;
    return (
      <span className="hero-title" style={sweepStyle}>
        <span className="hero-title-layer hero-title-base">
          {lines.map((line, lineIndex) => (
            <span className="hero-title-line" key={`${line}-${lineIndex}`}>
              <motion.span
                className="hero-title-line-inner"
                initial="hidden"
                animate="visible"
                transition={{
                  staggerChildren: 0.06,
                  delayChildren: lineIndex * 0.2,
                }}
              >
                {line.split("").map((char, index) => (
                  <motion.span
                    key={`${lineIndex}-${char}-${index}`}
                    variants={titleCharVariants}
                    className="hero-title-char"
                    style={{ display: "inline-block", whiteSpace: "pre" }}
                  >
                    {char}
                  </motion.span>
                ))}
              </motion.span>
            </span>
          ))}
        </span>
        <span className="hero-title-layer hero-title-sweep" aria-hidden="true">
          {lines.map((line, lineIndex) => (
            <span className="hero-title-line" key={`sweep-${line}-${lineIndex}`}>
              <span className="hero-title-line-inner">{line}</span>
            </span>
          ))}
        </span>
      </span>
    );
  };

  if (isLoading) {
    return (
      <div
        className="home"
        ref={homeRef}
        style={{ display: "flex", justifyContent: "center", alignItems: "center" }}
      >
        <div className="state">
          <strong>正在读取投票数据</strong>
          <p>数据库正在响应，请稍候。</p>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="home"
        ref={homeRef}
        style={{ display: "flex", justifyContent: "center", alignItems: "center" }}
      >
        <div className="state">
          <strong>无法加载投票项目</strong>
          <p>{error instanceof Error ? error.message : "未知错误。"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="home" ref={homeRef}>
      {/* Hero Page */}
      <section className="page-hero">
        <motion.div
          variants={heroContainerVariants}
          initial="hidden"
          animate="visible"
          style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 24, zIndex: 1 }}
        >
          <motion.span className="hero-tag" variants={itemVariants}>
            The ChargeDB Awards 2025
          </motion.span>
          <h1 style={{ display: "inline-block", margin: 0 }}>
            <AnimatedTitle lines={["2025 ChargeDB", "年度充电大赏"]} />
          </h1>
          <motion.p variants={itemVariants}>
            本次评选采用邀请制，
            <span
              style={{
                cursor: "pointer",
                textDecoration: "underline",
                color: "var(--primary)",
              }}
              onClick={() => setInviteInfoOpen(true)}
            >
              点击此处
            </span>
            如何获取邀请码。对于每个奖项，最多可投两票（可以重复，也可以放弃投票）。
          </motion.p>
        </motion.div>

        <motion.div
          className="hero-actions"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.6 }}
        >
          <button
            type="button"
            className="primary-button lg"
            onClick={startVoting}
            disabled={items.length === 0}
          >
            {votingUnlocked ? "继续投票" : "开启评选"}
          </button>
          <div className="hero-stats">
            <span>已投 {totalVotes} 票</span>
            <span>{groupedItems.length} 个奖项</span>
          </div>
        </motion.div>
      </section>

      {/* Category Pages */}
      {groupedItems.map((group) => {
        const categoryTotal = getCategoryTotal(group.name);
        return (
          <section className="category-page" key={group.name} id={`category-${group.name}`}>
            <motion.header
              className="category-header"
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <div className="category-selector">
                <button
                  type="button"
                  className="category-selector-trigger"
                  onClick={() => toggleCategorySelector(group.name)}
                  aria-expanded={
                    isCategorySelectorOpen && categorySelectorAnchor === group.name
                  }
                  aria-haspopup="listbox"
                >
                  <h2>{group.name}</h2>
                  <p
                    style={{
                      margin: "4px 0 0",
                      color: "var(--muted)",
                      fontSize: "0.9rem",
                    }}
                  >
                    {group.items.length} 个候选项目
                  </p>
                </button>
                {isCategorySelectorOpen && categorySelectorAnchor === group.name ? (
                  <motion.div
                    className="category-selector-panel"
                    variants={selectorPanelVariants}
                    initial="hidden"
                    animate="visible"
                  >
                    <motion.div
                      className="category-selector-list"
                      variants={selectorListVariants}
                      role="listbox"
                    >
                      {groupedItems.map((option) => (
                        <motion.button
                          key={option.name}
                          type="button"
                          className="category-option"
                          variants={selectorItemVariants}
                          role="option"
                          onClick={() => scrollToCategory(option.name)}
                        >
                          {option.name}
                        </motion.button>
                      ))}
                    </motion.div>
                  </motion.div>
                ) : null}
              </div>
              <div className="category-votes">
                已投 {categoryTotal}/{MAX_VOTES_PER_CATEGORY}
              </div>
            </motion.header>

            <div className="entries-container">
              <div className="entries-grid">
                {group.items.map((item) => {
                  const currentVotes = getCategoryVotes(group.name)[item.id] ?? 0;
                  const categoryAtLimit = categoryTotal >= MAX_VOTES_PER_CATEGORY;
                  const canIncrement =
                    !categoryAtLimit && currentVotes < MAX_VOTES_PER_CATEGORY;

                  return (
                    <article className="entry-card" key={item.id}>
                      <div className="media">
                        {item.image ? (
                          <img src={item.image} alt={item.title} />
                        ) : (
                          <div className="media-fallback">暂无图片</div>
                        )}
                      </div>
                      <div className="entry-body">
                        <div className="entry-title">
                          {item.brand && <span className="entry-brand">{item.brand}</span>}
                          <h3>{item.title}</h3>
                        </div>
                        <div className="entry-details">
                          <div className="entry-tags">
                            <span className="entry-tag">
                              {item.model ? `型号：${item.model}` : "型号待补充"}
                            </span>
                            <span className="entry-tag">
                              {item.specs ? `规格：${item.specs}` : "规格待补充"}
                            </span>
                          </div>
                          <p className="entry-reason">
                            {item.reason || "暂无推荐理由"}
                          </p>
                        </div>
                        <div className="card-footer">
                          <div
                            className="vote-control"
                            data-locked={!votingUnlocked}
                          >
                            <button
                              type="button"
                              className="vote-step"
                              onClick={() => decrementVote(group.name, item.id)}
                              disabled={!votingUnlocked || currentVotes === 0}
                            >
                              -
                            </button>
                            <button type="button" className="vote-count" disabled>
                              {currentVotes}/{MAX_VOTES_PER_CATEGORY}
                            </button>
                            <button
                              type="button"
                              className="vote-step"
                              onClick={() => incrementVote(group.name, item.id)}
                              disabled={!votingUnlocked || !canIncrement}
                            >
                              +
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}

      {/* Submit Page */}
      <section className="submit-page">
        <motion.div
          className="submit-content"
          initial={{ opacity: 0, scale: 0.9 }}
          whileInView={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6 }}
        >
          <div>
            <h2>感谢参与</h2>
            <p>您已完成所有项目的浏览。</p>
          </div>
          <button
            type="button"
            className="primary-button lg"
            onClick={openReview}
            disabled={!votingUnlocked}
          >
            查看并提交 ({totalVotes})
          </button>
        </motion.div>
      </section>

      {keyModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <motion.div
            className="modal key-modal"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
          >
            <form className="modal-form" onSubmit={handleKeySubmit}>
              <div className="modal-header">
                <div>
                  <h2>请输入邀请码</h2>
                  <p>每个邀请码仅可使用一次。</p>
                </div>
                <button
                  type="button"
                  className="modal-link"
                  onClick={openInviteInfoFromKeyModal}
                  disabled={isKeySubmitting}
                >
                  获取邀请码
                </button>
              </div>
              <div className="modal-body">
                <div className="input-group">
                  <label className="input-label" htmlFor="vote-key">
                    邀请码
                  </label>
                  <input
                    id="vote-key"
                    type="password"
                    className="text-input"
                    value={keyInput}
                    onChange={(event) => setKeyInput(event.target.value)}
                    placeholder="请输入邀请码"
                  />
                </div>
                {keyError ? <p className="error">{keyError}</p> : null}
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={closeKeyModal}
                  disabled={isKeySubmitting}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={isKeySubmitting}
                >
                  {isKeySubmitting ? "验证中..." : "开始投票"}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      ) : null}

      {reviewOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <motion.div
            className="modal"
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", damping: 20, stiffness: 300 }}
          >
            <div className="modal-header">
              <div>
                <h2>检查全部投票</h2>
                <p>确认后将提交您的结果，无法更改。</p>
              </div>
            </div>
            <div className="modal-body">
              {groupedItems.map((group) => {
                const selections = group.items
                  .map((item) => ({
                    ...item,
                    count: getCategoryVotes(group.name)[item.id] ?? 0,
                  }))
                  .filter((item) => item.count > 0);
                return (
                  <div className="review-section" key={group.name}>
                    <div className="review-header">
                      <h3>{group.name}</h3>
                      <span>
                        已投 {getCategoryTotal(group.name)}/{MAX_VOTES_PER_CATEGORY}
                      </span>
                    </div>
                    {selections.length === 0 ? (
                      <p className="review-empty">未投票</p>
                    ) : (
                      <ul className="review-list">
                        {selections.map((item) => (
                          <li key={item.id}>
                            <span>{item.displayName}</span>
                            <strong>{item.count} 票</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
            {submitError ? <p className="error">{submitError}</p> : null}
            <div className="modal-actions">
              {submitSuccess ? (
                <button
                  type="button"
                  className="primary-button"
                  onClick={closeReview}
                >
                  提交成功，返回
                </button>
              ) : (
                <>
                  <button type="button" className="ghost-button" onClick={closeReview}>
                    返回修改
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? "正在提交..." : "确认提交"}
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </div>
      ) : null}

      {inviteInfoOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <motion.div
            className="modal"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
          >
            <div className="modal-header">
              <div>
                <h2>如何获取邀请码</h2>
              </div>
            </div>
            <div className="modal-body">
              <p style={{ lineHeight: 1.6, color: "var(--text-secondary)" }}>
                本活动面向充电爱好玩家、极客与行业从业者，为了防止刷票或其他不正当竞争行为，需在确认身份后获得评选邀请码。
              </p>
              <p
                style={{
                  marginTop: 12,
                  lineHeight: 1.6,
                  color: "var(--text-secondary)",
                }}
              >
                可联系酷安@珊瑚宫心海、小红书@苻铃Furin、哔哩哔哩@是动动小圆帽吗，或发送邮件到
                FurinCoraline@gmail.com。
              </p>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => setInviteInfoOpen(false)}
              >
                知道了
              </button>
            </div>
          </motion.div>
        </div>
      ) : null}
    </div>
  );
}
