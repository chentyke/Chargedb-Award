import { Link } from "@tanstack/react-router";

export default function ThankYou() {
    return (
        <div className="submit-page">
            <div className="submit-content">
                <div>
                    <h2>感谢您的参与</h2>
                    <p>您的投票已成功提交。每一次参与都将帮助我们评选出更优秀的储能产品。</p>
                </div>
                <Link to="/" className="primary-button lg" style={{ textDecoration: "none" }}>
                    返回首页
                </Link>
            </div>
        </div>
    );
}
